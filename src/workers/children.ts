import type { ChildProcess } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { hydraDir } from '#app/home-migration.ts'
import { processStart } from '#app/server-state.ts'
import { pnyxHome, replaceFile } from '#store/storage.ts'

const OLD_HOST_STOP_MS = 30_000
// How long the start waits for an earlier server's agents and their tools to be gone.
const SWEEP_WAIT_MS = 10_000
const SWEEP_POLL_MS = 50

// Agents run in a process group of their own, so the tools they start go with them.
const signalTree = ({
  pid,
  signal,
}: {
  pid: number
  signal: NodeJS.Signals | 0
}) => {
  for (const target of [
    -pid,
    pid,
  ]) {
    try {
      process.kill(
        target,
        signal,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`pnyx-axi serve: could not signal leftover agent ${pid}: ${(error as Error).message}`)
      }
    }
  }
}

const treeAlive = ({ pid }: { pid: number }) => [
  -pid,
  pid,
].some(target => {
  try {
    process.kill(
      target,
      0,
    )

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
})

// Agent processes the server started, by pid and start time. A server that died without stopping them
// leaves them here; the next start stops them before it resumes their sessions, so no session runs twice.
type Recorded = {
  pid: number
  start: string
}

const childrenPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'children.json',
)

const read = ({ path }: { path: string }): Recorded[] => {
  try {
    return JSON.parse(readFileSync(
      path,
      'utf8',
    )) as Recorded[]
  } catch {
    return []
  }
}

const verified = ({
  pid,
  start,
  localTime,
}: Recorded & { localTime?: boolean }) => processStart({
  pid,
  localTime,
}) === start

export function trackChildren({ hydraId }: { hydraId: string }) {
  const path = childrenPath({ hydraId })
  const live = new Map<number, Recorded>()
  const save = () => replaceFile({
    path,
    text: JSON.stringify([...live.values()]),
  })

  return {
    // Stops what an earlier server left running, with every tool it started, and waits until they are gone.
    // Resolves false when one would not stop: its sessions must not resume while it may still be working.
    async sweep() {
      const left = read({ path }).filter(child => verified(child))

      for (const child of left) {
        signalTree({
          pid: child.pid,
          signal: 'SIGKILL',
        })
      }

      const end = Date.now() + SWEEP_WAIT_MS

      while (left.some(child => treeAlive({ pid: child.pid }))) {
        if (Date.now() > end) {
          console.error(`pnyx-axi serve: leftover agents did not stop: ${left.filter(child => treeAlive({ pid: child.pid }))
            .map(child => child.pid)
            .join(', ')}`)

          return false
        }

        await delay(SWEEP_POLL_MS)
      }

      rmSync(
        path,
        { force: true },
      )

      return true
    },
    spawned({ child }: { child: ChildProcess }) {
      const pid = child.pid
      const start = pid === undefined ? null : processStart({ pid })

      if (pid === undefined || !start) {
        return
      }

      live.set(
        pid,
        {
          pid,
          start,
        },
      )
      save()
      child.once(
        'exit',
        () => {
          live.delete(pid)
          save()
        },
      )
    },
  }
}

// The separate agent host of earlier builds, if one outlived the switch to this build. SIGTERM lets it close
// its own agents, which it started in their own process groups.
export async function stopOldHost() {
  const owner = read({
    path: join(
      pnyxHome(),
      'native/owner.json',
    ),
  }) as unknown as Partial<Recorded>

  if (typeof owner.pid !== 'number' || typeof owner.start !== 'string') {
    return
  }

  const host = {
    pid: owner.pid,
    start: owner.start,
    localTime: true,
  }

  if (!verified(host)) {
    return
  }

  process.kill(
    host.pid,
    'SIGTERM',
  )

  for (const end = Date.now() + OLD_HOST_STOP_MS; verified(host);) {
    if (Date.now() > end) {
      process.kill(
        host.pid,
        'SIGKILL',
      )

      return
    }

    await delay(100)
  }
}
