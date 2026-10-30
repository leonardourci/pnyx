import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { processStart } from './discovery.ts'
import { fail } from './protocol.ts'

const TERM_WAIT_MS = 500
const KILL_WAIT_MS = 2000
const POLL_MS = 25
export type NativeGroup = {
  id: number
  start: string
}

function processes(): {
  pid: number
  group: number
  state: string
}[] | undefined {
  try {
    const rows = execFileSync(
      '/bin/ps',
      [
        '-A',
        '-o',
        'pid=,pgid=,stat=',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map(line => {
        const [
          pid,
          group,
          state,
        ] = line.trim().split(/\s+/)

        return {
          pid: Number(pid),
          group: Number(group),
          state,
        }
      })
    const valid = rows.every(row => Number.isSafeInteger(row.pid) && row.pid > 0
      && Number.isSafeInteger(row.group) && row.group >= 0 && typeof row.state === 'string' && row.state.length > 0)

    return valid ? rows : undefined
  } catch {
    // Unreadable process ownership cannot authorize another native owner.
    return undefined
  }
}

export function nativeGroup({ pid }: { pid: number }): NativeGroup {
  const start = processStart({ pid })
  const observed = processes()
  const own = observed?.find(process => process.pid === pid)

  if (!start || own?.group !== pid) {
    fail({
      code: 'OWNERSHIP_UNKNOWN',
      message: 'The provider child has no verified private process group',
    })
  }

  return {
    id: pid,
    start,
  }
}

export async function endGroup({ group }: { group: NativeGroup }): Promise<boolean> {
  if (!group || !Number.isSafeInteger(group.id) || group.id <= 1 || typeof group.start !== 'string' || !group.start) {
    return false
  }

  const members = processes()
  const ownGroup = members?.find(member => member.pid === process.pid)?.group

  if (!members || ownGroup === undefined || ownGroup === group.id) {
    return false
  }

  const empty = () => {
    const current = processes()

    return current !== undefined && !current.some(member => member.group === group.id && !member.state.startsWith('Z'))
  }

  if (empty()) {
    return true
  }

  const start = processStart({ pid: group.id })

  if (start && start !== group.start) {
    return false
  }

  const wait = async ({ duration }: { duration: number }) => {
    const deadline = Date.now() + duration

    do {
      if (empty()) {
        return true
      }

      await setTimeout(POLL_MS)
    } while (Date.now() < deadline)

    return empty()
  }

  // Tools that detach into another process group can survive this boundary.
  for (const step of [
    {
      signal: 'SIGTERM',
      duration: TERM_WAIT_MS,
    },
    {
      signal: 'SIGKILL',
      duration: KILL_WAIT_MS,
    },
  ] as const) {
    try {
      process.kill(
        -group.id,
        step.signal,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return true
      }

      return false
    }

    if (await wait({ duration: step.duration })) {
      return true
    }
  }

  return false
}
