import { homedir } from 'node:os'
import type { HydraState } from '../core/model.ts'
import type { UpgradeOperation } from './model.ts'
import { runUpgrade } from './runner.ts'

const WAIT_MS = 100

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
  restart(): void
  at(): string
}) {
  const sendNow = new Set<string>()

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
    record({ operation: running })
    const result = await runUpgrade({
      root: root!,
      progress: ({ steps }) => record({
        operation: {
          ...running,
          steps: structuredClone(steps),
        },
      }),
    })
    const {
      state: outcome,
      ...rest
    } = result

    if (outcome !== 'upgraded') {
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

    record({
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
    restart()
  }

  const enqueue = ({ queued }: { queued: UpgradeOperation }) => schedule({
    id: queued.id,
    run: () => run({ queued }).catch((error: Error) => record({
      operation: {
        ...queued,
        state: 'failed',
        error: error.message,
        rolledBack: false,
        endedAt: at(),
      },
    })),
  })

  return {
    request({ id }: { id: string }) {
      // One upgrade at a time: a second /upgrade while one waits or runs changes nothing.
      if (state().upgrades?.some(operation => operation.id === id
        || [
          'queued',
          'running',
          'restarting',
        ].includes(operation.state))) {
        return
      }

      const queued: UpgradeOperation = {
        id,
        state: root ? 'queued' : 'refused',
        folder: root ? shortHome({ path: root }) : '',
        queuedAt: at(),
        steps: [],
        ...root ? {} : {
          reasons: ['This Pnyx server has no folder to upgrade.'],
          endedAt: at(),
        },
      }
      record({
        operation: queued,
        eventId: `${id}:hosted`,
      })

      if (root) {
        enqueue({ queued })
      }
    },

    // The queue's Send now: run without waiting for Hydra's turn to end.
    sendNow({ id }: { id: string }) {
      if (!state().upgrades?.some(operation => operation.id === id && operation.state === 'queued')) {
        return false
      }

      sendNow.add(id)

      return true
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
