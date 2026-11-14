import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const readProcessTable = promisify(execFile)
const STOP_GRACE_MS = 250
const PROCESS_TABLE_BYTES = 8 * 1024 * 1024

type ProcessIdentity = {
  pid: number
  parent: number
  start: string
  command: string
}

async function processes(): Promise<Map<number, ProcessIdentity>> {
  const { stdout } = await readProcessTable(
    'ps',
    [
      '-axo',
      'pid=,ppid=,lstart=,command=',
    ],
    {
      maxBuffer: PROCESS_TABLE_BYTES,
    },
  )
  const found = new Map<number, ProcessIdentity>()

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
  table: Map<number, ProcessIdentity>
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

// The app-server's process group also holds deliberately backgrounded commands, so Stop signals verified PIDs only.
export function codexProcesses({ pid }: { pid?: number }) {
  let baseline = new Map<number, ProcessIdentity>()
  const foreground = new Map<string, string>()

  return {
    async begin() {
      foreground.clear()
      baseline = pid ? await processes() : new Map()
    },
    command({
      id,
      command,
      completed,
    }: {
      id: string
      command: string
      completed: boolean
    }) {
      if (completed) {
        foreground.delete(id)
      } else {
        foreground.set(
          id,
          command,
        )
      }
    },
    async capture() {
      if (!pid || !foreground.size) {
        return async () => [] as number[]
      }

      const table = await processes()
      const roots = [...table.values()].filter(process => {
        if (baseline.get(process.pid)?.start === process.start || process.pid === pid) {
          return false
        }

        const commandMatches = [...foreground.values()].some(command => process.command === command
          || process.command.endsWith(` -c ${command}`) || process.command.endsWith(` -lc ${command}`))

        return commandMatches && parentChain({
          table,
          pid: process.pid,
          ancestor: pid,
        })
      })
      const targets = [...table.values()].filter(process => process.pid !== pid
        && roots.some(root => parentChain({
          table,
          pid: process.pid,
          ancestor: root.pid,
        })))
      const stopped: number[] = []

      const signal = async ({
        target,
        signal,
      }: {
        target: ProcessIdentity
        signal: NodeJS.Signals
      }) => {
        const current = await processes()
        const original = parentChain({
          table,
          pid: target.pid,
          ancestor: pid,
        })
        const chain = parentChain({
          table: current,
          pid: target.pid,
          ancestor: pid,
        })
        const surviving = current.get(target.pid)
        const alreadySignalled = stopped.includes(target.pid) && surviving?.start === target.start
          && surviving.command === target.command
        const sameChain = original && chain && original.length === chain.length && original.every((
          entry,
          index,
        ) => {
          const now = chain[index]

          return now?.pid === entry.pid && now.parent === entry.parent && now.start === entry.start
        })

        if (!sameChain && !alreadySignalled) {
          return
        }

        try {
          process.kill(
            target.pid,
            signal,
          )

          if (!stopped.includes(target.pid)) {
            stopped.push(target.pid)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      return async () => {
        // Children first keeps their parent chain verifiable while each signal is checked.
        const deepest = targets.toSorted((
          left,
          right,
        ) =>
          (parentChain({
            table,
            pid: right.pid,
            ancestor: pid,
          })?.length ?? 0)
          - (parentChain({
            table,
            pid: left.pid,
            ancestor: pid,
          })?.length ?? 0))

        for (const target of deepest) {
          await signal({
            target,
            signal: 'SIGTERM',
          })
        }

        await delay(STOP_GRACE_MS)

        for (const target of deepest) {
          await signal({
            target,
            signal: 'SIGKILL',
          })
        }

        return stopped
      }
    },
  }
}
