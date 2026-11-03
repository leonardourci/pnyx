import { HydraError } from '#store/errors.ts'
import { homedir } from 'node:os'
import type { HydraState } from '#app/model.ts'
import type { UpgradeOperation } from './model.ts'
import { runUpgrade } from './runner.ts'
import { background } from '#app/background.ts'

const WAIT_MS = 100
// Bound how long messages remain held if the restart process does not complete.
const RESTART_WAIT_MS = 60_000

const shortHome = ({ path }: { path: string }) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

// /upgrade takes its place in Hydra's turn queue, runs once Hydra's turn ends, and restarts only after a passing build.
export function upgradeQueue({
  root,
  state,
  record,
  schedule,
  working,
  closing,
  restart,
  at,
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
  // Puts run behind the Hydra turns already queued; later messages and wakes wait behind it.
  schedule({
    id,
    run,
  }: {
    id: string
    run(): Promise<void>
  }): void
  // Hydra's turn or a compaction is running.
  working(): boolean
  closing(): boolean
  restart(): void | Promise<void>
  at(): string
}) {
  const sendNow = new Set<string>()
  let stopping: AbortController | undefined

  const active = () => state().upgrades?.find(operation => [
    'queued',
    'running',
    'restarting',
  ].includes(operation.state))

  const save = ({
    operation,
    eventId,
  }: {
    operation: UpgradeOperation
    eventId?: string
  }) => record({
    operation,
    eventId,
  })

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
      save({
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
    // Ends with the turn, Send now or shutdown, as /compact waits for its turn.
    while (working() && !sendNow.has(queued.id) && !closing()) {
      await new Promise(resolve => setTimeout(
        resolve,
        WAIT_MS,
      ))
    }

    sendNow.delete(queued.id)

    // A queued upgrade cut by a stop runs when the next server starts.
    if (closing()) {
      return
    }

    const running: UpgradeOperation = {
      ...queued,
      state: 'running',
      startedAt: at(),
    }
    save({ operation: running })
    stopping = new AbortController()
    let result: Awaited<ReturnType<typeof runUpgrade>>

    try {
      result = await runUpgrade({
        root: root!,
        signal: stopping.signal,
        progress: ({ steps }) => save({
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
      save({
        operation: {
          ...running,
          ...rest,
          state: outcome,
          endedAt: at(),
        },
      })

      return
    }

    save({
      operation: {
        ...running,
        ...rest,
        state: 'restarting',
        steps: [
          ...rest.steps,
          {
            step: 'restart',
            state: 'running',
            seconds: 0,
          },
        ],
      },
    })
    await monitorRestart({ id: running.id })
  }

  const enqueue = ({ queued }: { queued: UpgradeOperation }) => schedule({
    id: queued.id,
    run: async () => {
      try {
        await run({ queued })
      } catch (error) {
        save({
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

    // The queue's Send now: run without waiting for Hydra's turn to end.
    sendNow({ id }: { id: string }) {
      if (!state().upgrades?.some(operation => operation.id === id && operation.state === 'queued')) {
        return false
      }

      sendNow.add(id)

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
        if (operation.state === 'restarting') {
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
