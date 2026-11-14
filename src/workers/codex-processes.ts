import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '#app/diagnostics.ts'

const readProcessTable = promisify(execFile)
const PROCESS_TABLE_BYTES = 8 * 1024 * 1024
// A turn waits for the baseline read, so a stuck `ps` gives up and leaves Stop with nothing to end.
const PROCESS_TABLE_TIMEOUT_MS = 10_000
// How `ps` prints a byte it cannot show: a newline as \012, a tab as \011, a byte above ASCII as M- and its low bits.
const PRINTED_BYTE = /\\[0-7]{3}|M-./g
const NOT_ALPHANUMERIC = /[^A-Za-z0-9]/g

type ProcessIdentity = {
  pid: number
  parent: number
  start: string
  command: string
}

type ProcessTable = Map<number, ProcessIdentity>

async function processes(): Promise<ProcessTable> {
  const { stdout } = await readProcessTable(
    'ps',
    [
      '-axo',
      'pid=,ppid=,lstart=,command=',
    ],
    {
      maxBuffer: PROCESS_TABLE_BYTES,
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    },
  )
  const found: ProcessTable = new Map()

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line)

    if (match) {
      const pid = Number(match[1])
      found.set(
        pid,
        {
          pid,
          parent: Number(match[2]),
          start: match[3]!,
          command: match[4]!,
        },
      )
    }
  }

  return found
}

function parentChain({
  table,
  pid,
  ancestor,
}: {
  table: ProcessTable
  pid: number
  ancestor: number
}): ProcessIdentity[] | undefined {
  const chain: ProcessIdentity[] = []
  const visited = new Set<number>()

  let current = table.get(pid)

  while (current && !visited.has(current.pid)) {
    visited.add(current.pid)
    chain.push(current)

    if (current.pid === ancestor) {
      return chain
    }

    current = table.get(current.parent)
  }

  return undefined
}

// A command as Codex reports it and as `ps` prints it differ in quotes, escapes and line breaks, so both reduce to their letters and digits.
function commandKey({ text }: { text: string }): string {
  return text.replace(
    PRINTED_BYTE,
    '',
  ).replace(
    NOT_ALPHANUMERIC,
    '',
  )
}

function warn({
  operation,
  error,
}: {
  operation: string
  error: unknown
}) {
  log({
    level: 'warn',
    operation,
    error,
  })
}

// The app-server's process group also holds deliberately backgrounded commands, so Stop signals verified PIDs only.
// Cleanup is best effort: a failure is logged and never stops the turn or the session.
export function codexProcesses({ pid }: { pid?: number }) {
  let baseline: Promise<ProcessTable | undefined> = Promise.resolve(undefined)
  const foreground = new Map<string, string[]>()

  return {
    // Reads the processes that already run; the turn starts once ready() has it, and capture waits for it too.
    begin() {
      foreground.clear()
      baseline = pid ? processes().catch((error: unknown) => {
        warn({
          operation: 'codex.processes.baseline',
          error,
        })

        return undefined
      }) : Promise.resolve(undefined)
    },
    async ready() {
      await baseline
    },
    command({
      id,
      commands,
      completed,
    }: {
      id: string
      commands: string[]
      completed: boolean
    }) {
      if (completed) {
        foreground.delete(id)
      } else {
        foreground.set(
          id,
          commands.map(text => commandKey({ text })).filter(Boolean),
        )
      }
    },
    async capture() {
      const noCleanup = async () => [] as number[]

      if (!pid || !foreground.size) {
        return noCleanup
      }

      try {
        const earlier = await baseline

        // Without the processes from before the turn, nothing can be told apart safely.
        if (!earlier) {
          return noCleanup
        }

        return await captureForeground({
          pid,
          earlier,
          keys: [...foreground.values()].flat(),
        })
      } catch (error) {
        warn({
          operation: 'codex.processes.capture',
          error,
        })

        return noCleanup
      }
    },
  }
}

async function captureForeground({
  pid,
  earlier,
  keys,
}: {
  pid: number
  earlier: ProcessTable
  keys: string[]
}) {
  const table = await processes()
  const roots = [...table.values()].filter(process => {
    if (earlier.get(process.pid)?.start === process.start || process.pid === pid) {
      return false
    }

    const key = commandKey({ text: process.command })

    return keys.some(wanted => key.endsWith(wanted)) && parentChain({
      table,
      pid: process.pid,
      ancestor: pid,
    })
  })
  const depth = ({ target }: { target: ProcessIdentity }) => parentChain({
    table,
    pid: target.pid,
    ancestor: pid,
  })?.length ?? 0
  const targets = [...table.values()].filter(process => process.pid !== pid
    && roots.some(root => parentChain({
      table,
      pid: process.pid,
      ancestor: root.pid,
    })))
  // Freeze parents first so killing a child cannot let its shell execute the next command.
  const parentsFirst = targets.toSorted((
    left,
    right,
  ) => depth({ target: left }) - depth({ target: right }))

  const signalTarget = ({
    target,
    signal,
  }: {
    target: ProcessIdentity
    signal: NodeJS.Signals
  }): boolean => {
    try {
      process.kill(
        target.pid,
        signal,
      )

      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        warn({
          operation: 'codex.processes.signal',
          error,
        })
      }

      return false
    }
  }

  // One read of the table verifies every target before it is frozen.
  const freeze = async () => {
    const current = await processes()

    return parentsFirst.filter(target => {
      const chain = parentChain({
        table: current,
        pid: target.pid,
        ancestor: pid,
      })
      const original = parentChain({
        table,
        pid: target.pid,
        ancestor: pid,
      })
      const sameChain = original && chain && original.length === chain.length && original.every((
        entry,
        index,
      ) => {
        const now = chain[index]

        return now?.pid === entry.pid && now.parent === entry.parent && now.start === entry.start
      })

      return sameChain && signalTarget({
        target,
        signal: 'SIGSTOP',
      })
    })
  }

  return async () => {
    let frozen: ProcessIdentity[] = []

    try {
      frozen = await freeze()
    } catch (error) {
      warn({
        operation: 'codex.processes.cleanup',
        error,
      })
    }

    // A frozen process cannot exit, so its PID is still its own when it is killed.
    return frozen.toReversed().filter(target => signalTarget({
      target,
      signal: 'SIGKILL',
    }))
      .map(target => target.pid)
  }
}
