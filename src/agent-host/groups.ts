import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { fail } from './protocol.ts'

const TERM_WAIT_MS = 500
const KILL_WAIT_MS = 2000
const POLL_MS = 25
const READ_TIMEOUT_MS = 1000
const SECOND_MS = 1000
export type NativeGroup = {
  id: number
  start: string
}
type Member = {
  pid: number
  group: number
  state: string
  start: string
  started: number
}

function processes(): Member[] | undefined {
  try {
    const rows = execFileSync(
      '/bin/ps',
      [
        '-A',
        '-o',
        'pid=,pgid=,stat=,lstart=',
      ],
      {
        encoding: 'utf8',
        timeout: READ_TIMEOUT_MS,
        env: {
          ...process.env,
          LC_ALL: 'C',
          TZ: 'UTC',
        },
      },
    ).trim()
      .split('\n')
      .map(line => {
        const [
          pid,
          group,
          state,
          ...date
        ] = line.trim().split(/\s+/)
        const start = date.join(' ')

        return {
          pid: Number(pid),
          group: Number(group),
          state,
          start,
          started: Date.parse(`${start} UTC`),
        }
      })
    const valid = rows.every(row => Number.isSafeInteger(row.pid) && row.pid > 0
      && Number.isSafeInteger(row.group) && row.group >= 0 && typeof row.state === 'string' && row.state.length > 0)

    return valid ? rows : undefined
  } catch {
    return undefined
  }
}

export function nativeGroup({ pid }: { pid: number }): NativeGroup {
  const own = processes()?.find(member => member.pid === pid)

  if (!own || own.group !== pid || !Number.isFinite(own.started)) {
    fail({
      code: 'OWNERSHIP_UNKNOWN',
      message: 'The provider child has no verified private process group',
    })
  }

  return {
    id: pid,
    start: own.start,
  }
}

export async function endGroup({
  group,
  lastAliveAt,
}: {
  group: NativeGroup
  lastAliveAt?: number
}): Promise<void> {
  if (!group || !Number.isSafeInteger(group.id) || group.id <= 1 || typeof group.start !== 'string' || !group.start
    || typeof lastAliveAt !== 'number' || !Number.isFinite(lastAliveAt) || lastAliveAt <= 0) {
    return
  }

  const cutoff = Math.floor(lastAliveAt / SECOND_MS) * SECOND_MS

  const eligible = () => {
    const members = processes()
    const own = members?.find(member => member.pid === process.pid)
    const leader = members?.find(member => member.pid === group.id)

    if (!members || !own || own.group === group.id || leader && leader.start !== group.start) {
      return []
    }

    return members.filter(member => member.group === group.id && member.pid > 1
      && !member.state.startsWith('Z') && Number.isFinite(member.started) && member.started < cutoff)
  }

  const wait = async ({ duration }: { duration: number }) => {
    const deadline = Date.now() + duration

    do {
      if (!eligible().length) {
        return true
      }

      await setTimeout(POLL_MS)
    } while (Date.now() < deadline)

    return !eligible().length
  }

  // Unknown/newer members may survive like detached tools; macOS has no pidfd for the signal race.
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
    for (const member of eligible()) {
      const current = eligible().find(candidate => candidate.pid === member.pid)

      if (!current || current.start !== member.start) {
        continue
      }

      try {
        process.kill(
          current.pid,
          step.signal,
        )
      } catch {
        // Cleanup failure leaves the member alone; it never fences the resumed agent.
      }
    }

    if (await wait({ duration: step.duration })) {
      return
    }
  }
}
