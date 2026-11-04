import { HydraError } from '#store/errors.ts'
import { homedir } from 'node:os'
import type { HydraState } from '#app/model.ts'
import type { UpgradeOperation } from './model.ts'
import { runUpgrade } from './runner.ts'
import { background } from '#app/background.ts'

const WAIT_MS = 100
// Bound how long messages remain held if the restart process does not complete.
const RESTART_WAIT_MS = 60_000
// A built upgrade restarts at the next moment no agent is mid-turn, but never later than this.
export const RESTART_PENDING_MS = 15 * 60_000
// How often a built upgrade looks for a moment no agent is mid-turn.
const IDLE_POLL_MS = 1000

// Upgrades of any Hydra this server runs that are installing, building or waiting to restart.
const underway = new Set<string>()

// While one is, the server starts no index process, which would load the new build into the old server's work.
export const upgradeUnderway = () => underway.size > 0

const shortHome = ({ path }: { path: string }) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

// /upgrade pulls, installs and builds at once; after a passing build it restarts on Restart now,
// at the next moment no agent on any Hydra is mid-turn, or after RESTART_PENDING_MS at most.
export function upgradeQueue({
  root,
  state,
  record,
  midTurn,
  closing,
  restart,
  at,
  pendingMs = RESTART_PENDING_MS,
}: {
  // The Pnyx folder; a server without one refuses /upgrade.
  root?: string
  state(): HydraState
  // Appends the operation's new state; eventId marks the Hydra message it answers as taken.
  record({
    operation,
    eventId,
  }: {
    operation: UpgradeOperation
    eventId?: string
  }): void
  // Whether an agent on any Hydra this server runs is mid-turn.
  midTurn(): boolean
  closing(): boolean
  restart(): void | Promise<void>
  at(): string
  // How long a built upgrade waits for agents between turns.
  pendingMs?: number
}) {
  const restartNow = new Set<string>()
  let stopping: AbortController | undefined

  const active = () => state().upgrades?.find(operation => [
    'queued',
    'running',
    'waiting',
    'restarting',
  ].includes(operation.state))

  const monitorRestart = async ({ id }: { id: string }) => {
    const deadline = Date.now() + RESTART_WAIT_MS
    let failure: string | undefined

    try {
      const result = restart()

      if (result) {
        await Promise.race([
          result,
          new Promise<void>(resolve => setTimeout(
            resolve,
            RESTART_WAIT_MS,
          ).unref()),
        ])
      }
    } catch (error) {
      failure = (error as Error).message
    }

    while (!failure && !closing() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(
        resolve,
        WAIT_MS,
      ))
    }

    if (closing()) {
      return
    }

    const operation = state().upgrades?.find(item => item.id === id && item.state === 'restarting')

    if (operation) {
      record({
        operation: {
          ...operation,
          state: 'failed',
          failed: 'restart',
          error: failure ?? 'The application did not restart.',
          endedAt: at(),
          steps: operation.steps.map(step => step.step === 'restart' ? {
            ...step,
            state: 'failed',
          } : step),
        },
      })
    }
  }

  const run = async ({ queued }: { queued: UpgradeOperation }) => {
    // A queued upgrade cut by a stop runs when the next server starts.
    if (closing()) {
      return
    }

    const running: UpgradeOperation = {
      ...queued,
      state: 'running',
      startedAt: at(),
    }
    record({ operation: running })
    underway.add(running.id)
    stopping = new AbortController()
    let result: Awaited<ReturnType<typeof runUpgrade>>

    try {
      result = await runUpgrade({
        root: root!,
        signal: stopping.signal,
        progress: ({ steps }) => record({
          operation: {
            ...running,
            steps: structuredClone(steps),
          },
        }),
      })
    } finally {
      stopping = undefined
    }

    const {
      state: outcome,
      ...rest
    } = result

    if (outcome !== 'upgraded') {
      underway.delete(running.id)
      record({
        operation: {
          ...running,
          ...rest,
          state: outcome,
          endedAt: at(),
        },
      })

      return
    }

    const waiting: UpgradeOperation = {
      ...running,
      ...rest,
      state: 'waiting',
      restartBy: new Date(Date.now() + pendingMs).toISOString(),
    }
    record({ operation: waiting })
    await restartWhenIdle({ waiting })
  }

  const restartWhenIdle = async ({ waiting }: { waiting: UpgradeOperation }) => {
    const deadline = Date.parse(waiting.restartBy!)

    while (!closing() && !restartNow.has(waiting.id) && Date.now() < deadline && midTurn()) {
      await new Promise(resolve => setTimeout(
        resolve,
        IDLE_POLL_MS,
      ))
    }

    restartNow.delete(waiting.id)
    underway.delete(waiting.id)

    // The server is stopping anyway; the next one starts on the built code and records the upgrade done.
    if (closing()) {
      return
    }

    record({
      operation: {
        ...waiting,
        state: 'restarting',
        steps: [
          ...waiting.steps,
          {
            step: 'restart',
            state: 'running',
            seconds: 0,
          },
        ],
      },
    })
    await monitorRestart({ id: waiting.id })
  }

  const enqueue = ({ queued }: { queued: UpgradeOperation }) => background({
    name: 'upgrade',
    run: async () => {
      try {
        await run({ queued })
      } catch (error) {
        underway.delete(queued.id)
        record({
          operation: {
            ...queued,
            state: 'failed',
            error: (error as Error).message,
            rolledBack: false,
            endedAt: at(),
          },
        })
      }
    },
  })

  return {
    restart({ id }: { id: string }) {
      if (state().upgrades?.some(operation => operation.id === id)) {
        return
      }

      if (active()) {
        throw new HydraError({
          code: 'UPGRADE_BUSY',
          message: 'Wait for the current upgrade or restart to finish',
        })
      }

      record({
        operation: {
          id,
          state: 'restarting',
          folder: root ? shortHome({ path: root }) : '',
          queuedAt: at(),
          startedAt: at(),
          steps: [
            {
              step: 'restart',
              state: 'running',
              seconds: 0,
            },
          ],
        },
        eventId: `${id}:hosted`,
      })
      background({
        name: 'restart',
        run: () => monitorRestart({ id }),
      })
    },

    request({ id }: { id: string }) {
      // One upgrade at a time: a second /upgrade while one waits or runs changes nothing.
      if (active() || state().upgrades?.some(operation => operation.id === id)) {
        return
      }

      if (!root) {
        record({
          operation: {
            id,
            state: 'refused',
            folder: '',
            queuedAt: at(),
            endedAt: at(),
            steps: [],
            reasons: ['This Pnyx server has no folder to upgrade.'],
          },
          eventId: `${id}:hosted`,
        })

        return
      }

      const queued: UpgradeOperation = {
        id,
        state: 'queued',
        folder: shortHome({ path: root }),
        queuedAt: at(),
        steps: [],
      }
      record({
        operation: queued,
        eventId: `${id}:hosted`,
      })
      enqueue({ queued })
    },

    // Restart now: a built upgrade restarts without waiting for agents between turns.
    sendNow({ id }: { id: string }) {
      if (!state().upgrades?.some(operation => operation.id === id && operation.state === 'waiting')) {
        return false
      }

      restartNow.add(id)

      return true
    },

    // Stops the running upgrade, which goes back as a failed step does; a restart already under way cannot be stopped.
    stop() {
      const operation = active()

      if (operation?.state === 'restarting') {
        return 'restarting'
      }

      if (operation?.state !== 'running' || !stopping) {
        return undefined
      }

      stopping.abort()

      return 'stopping'
    },

    // After a restart: the upgrade that restarted this server is done, a queued one queues again,
    // and one a stop cut mid-run failed and may have left the folder partly upgraded.
    recover() {
      for (const operation of state().upgrades ?? []) {
        // A built upgrade that waited to restart runs its new code now, whatever restarted this server.
        if (operation.state === 'restarting' || operation.state === 'waiting') {
          record({
            operation: {
              ...operation,
              state: 'done',
              endedAt: at(),
              steps: operation.steps.map(step => step.step === 'restart' ? {
                ...step,
                state: 'done',
              } : step),
            },
          })
        } else if (operation.state === 'queued') {
          enqueue({ queued: operation })
        } else if (operation.state === 'running') {
          record({
            operation: {
              ...operation,
              state: 'failed',
              failed: operation.steps.at(-1)?.step,
              error: 'Pnyx stopped during the upgrade.',
              rolledBack: false,
              endedAt: at(),
            },
          })
        }
      }
    },
  }
}
