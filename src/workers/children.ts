import { log } from '#app/diagnostics.ts'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { hydraDir } from '#app/home-migration.ts'
import { processStart } from '#app/server-state.ts'
import { pnyxHome, replaceFile } from '#store/storage.ts'
import { HydraError } from '#store/errors.ts'

const OLD_HOST_STOP_MS = 30_000
// How long the start waits for an earlier server's agents and their tools to be gone.
const SWEEP_WAIT_MS = 10_000
const SWEEP_POLL_MS = 50
const STOP_GRACE_MS = 2000

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
        log({
          level: 'warn',
          operation: 'agent.signal',
          name: String(pid),
          error,
        })
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
  task?: string
  preserveTools?: true
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

  const retained = ({ child }: { child: Recorded }) => {
    const start = processStart({ pid: child.pid })

    return (start === null || start === child.start) && treeAlive({ pid: child.pid })
  }

  const stopping = new Map<string, Promise<void>>()

  const stop = async ({ task }: { task: string }) => {
    const recorded = [...live.values()].filter(child => child.task === task)

    if (!recorded.length) {
      return
    }

    // A group id stays unused while its group lives, so after this check the pid alone names the group.
    const owned = recorded.filter(child => retained({ child }))

    for (const child of owned) {
      signalTree({
        pid: child.pid,
        signal: 'SIGTERM',
      })
    }

    const grace = Date.now() + STOP_GRACE_MS
    const end = Date.now() + SWEEP_WAIT_MS
    const alive = () => owned.filter(child => treeAlive({ pid: child.pid }))

    while (alive().length) {
      if (Date.now() >= grace) {
        for (const child of alive()) {
          signalTree({
            pid: child.pid,
            signal: 'SIGKILL',
          })
        }
      }

      if (Date.now() >= end) {
        const pids = alive().map(child => child.pid)
          .join(', ')

        throw new HydraError({
          message: `Agent process groups for ${task} did not stop: ${pids}`,
          code: 'AGENT_STOP_FAILED',
          help: [`Stop processes ${pids} yourself, then retry the cleanup`],
        })
      }

      await delay(SWEEP_POLL_MS)
    }

    for (const child of recorded) {
      live.delete(child.pid)
    }

    save()
  }

  return {
    tasks() {
      return new Set([...live.values()].flatMap(child => child.task ? [child.task] : []))
    },
    associate({
      pid,
      task,
    }: {
      pid: number
      task: string
    }) {
      const child = live.get(pid)

      if (child) {
        child.task = task
        save()
      }
    },
    async stop({ task }: { task: string }) {
      let pending = stopping.get(task)

      if (!pending) {
        pending = stop({ task })
        stopping.set(
          task,
          pending,
        )
      }

      try {
        await pending
      } finally {
        if (stopping.get(task) === pending) {
          stopping.delete(task)
        }
      }
    },
    // Restart stops agent leaders while their background tools keep running until permanent close.
    async sweep() {
      const left = read({ path }).filter(child =>
        verified(child) || !child.preserveTools && retained({ child }))

      for (const child of left) {
        if (!child.preserveTools) {
          signalTree({
            pid: child.pid,
            signal: 'SIGKILL',
          })
          continue
        }

        try {
          process.kill(
            child.pid,
            'SIGKILL',
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      const end = Date.now() + SWEEP_WAIT_MS

      while (left.some(child =>
        child.preserveTools ? verified(child) : treeAlive({ pid: child.pid }))) {
        if (Date.now() > end) {
          const alive = left.filter(child => treeAlive({ pid: child.pid }))
          log({
            level: 'warn',
            operation: 'agent.sweep',
            count: alive.length,
            error: `leftover agents did not stop: ${alive.map(child => child.pid).join(', ')}`,
          })

          return false
        }

        await delay(SWEEP_POLL_MS)
      }

      const recorded = read({ path })

      for (const child of recorded.filter(child => retained({ child }))) {
        live.set(
          child.pid,
          child,
        )
      }

      // A durable write per Hydra adds up across a server start, so an unchanged record is left as it is.
      if (live.size !== recorded.length) {
        save()
      }

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
          preserveTools: true,
        },
      )
      save()
      child.once(
        'exit',
        () => {
          if (!treeAlive({ pid })) {
            live.delete(pid)
            save()
          }
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
