import { homedir } from 'node:os'
import type { HydraState } from '../core/model.ts'
import type { UpgradeOperation } from './model.ts'
import { PNYX_ROOT, runUpgrade } from './runner.ts'

const WAIT_MS = 100

const shortHome = ({ path }: { path: string }) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

// /upgrade waits in Hydra's queue like a message, runs when Hydra's turn ends, and restarts only after a passing build.
export function upgradeQueue({
  root = PNYX_ROOT,
  state,
  record,
  busy,
  closing,
  restart,
  at,
}: {
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
  busy(): boolean
  closing(): boolean
  restart(): void
  at(): string
}) {
  const sendNow = new Set<string>()

  const run = async ({ queued }: { queued: UpgradeOperation }) => {
    while (busy() && !sendNow.has(queued.id) && !closing()) {
      await new Promise(resolve => setTimeout(
        resolve,
        WAIT_MS,
      ))
    }

    sendNow.delete(queued.id)

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
      root,
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

  return {
    request({ id }: { id: string }) {
      if (state().upgrades?.some(operation => operation.id === id)) {
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
      void run({ queued }).catch((error: Error) => record({
        operation: {
          ...queued,
          state: 'failed',
          error: error.message,
          endedAt: at(),
        },
      }))
    },

    // The queue's Send now: run without waiting for Hydra's turn to end.
    sendNow({ id }: { id: string }) {
      if (!state().upgrades?.some(operation => operation.id === id && operation.state === 'queued')) {
        return false
      }

      sendNow.add(id)

      return true
    },

    // After a restart: the upgrade that restarted this server is done; one cut short by a stop failed.
    recover() {
      for (const operation of state().upgrades ?? []) {
        if (operation.state === 'restarting') {
          const endedAt = at()
          record({
            operation: {
              ...operation,
              state: 'done',
              endedAt,
              steps: operation.steps.map(step => step.step === 'restart' ? {
                ...step,
                state: 'done',
              } : step),
            },
          })
        } else if (operation.state === 'queued' || operation.state === 'running') {
          record({
            operation: {
              ...operation,
              state: 'failed',
              failed: operation.steps.at(-1)?.step,
              error: 'Pnyx stopped before the upgrade finished.',
              endedAt: at(),
            },
          })
        }
      }
    },
  }
}
