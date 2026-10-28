import { homedir } from 'node:os'
import type { HydraState } from '#app/model.ts'
import type { HeldMessage, UpgradeOperation } from './model.ts'
import { runUpgrade } from './runner.ts'

const WAIT_MS = 100
// The restart is a signal to this process; past this, the server did not restart and Hydra's queue moves on.
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
  deliver,
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
  // Hands a held message to Hydra, behind anything already queued.
  deliver({ message }: { message: HeldMessage }): void
  at(): string
}) {
  const sendNow = new Set<string>()
  let stopping: AbortController | undefined

  const active = () => state().upgrades?.find(operation => [
    'queued',
    'running',
    'restarting',
  ].includes(operation.state))

  // Messages held while the upgrade ran are kept on the operation, so a write made from an older copy must not drop them.
  const save = ({
    operation,
    eventId,
  }: {
    operation: UpgradeOperation
    eventId?: string
  }) => record({
    operation: {
      ...operation,
      held: operation.held ?? state().upgrades?.find(saved => saved.id === operation.id)?.held,
    },
    eventId,
  })

  // Once an upgrade has ended, the messages it held go to Hydra in the order they were sent.
  const release = () => {
    // A closing server leaves them held for the next one.
    if (closing()) {
      return
    }

    for (const operation of state().upgrades ?? []) {
      if (!operation.held?.length || [
        'running',
        'restarting',
      ].includes(operation.state)) {
        continue
      }

      for (const message of operation.held) {
        deliver({ message })
      }

      record({
        operation: {
          ...operation,
          held: [],
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
      release()

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
    restart()

    // Hydra's next turn waits for the restarted server, which hands it the held messages.
    const deadline = Date.now() + RESTART_WAIT_MS

    while (!closing() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(
        resolve,
        WAIT_MS,
      ))
    }

    if (!closing()) {
      console.error('pnyx-axi serve: the server did not restart after the upgrade; run `pnyx-axi stop` and start it again')
    }
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
        release()
      }
    },
  })

  return {
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

    // Holds a Hydra message sent while an upgrade runs or restarts; false when none does.
    hold({ message }: { message: HeldMessage }) {
      const operation = active()

      if (!operation || operation.state === 'queued') {
        return false
      }

      if (!operation.held?.some(held => held.id === message.id)) {
        record({
          operation: {
            ...operation,
            held: [
              ...operation.held ?? [],
              message,
            ],
          },
        })
      }

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

    release,

    // After a restart: the upgrade that restarted this server is done, a queued one queues again,
    // and one a stop cut mid-run failed and may have left the folder partly upgraded.
    // Their held messages wait for release, once the server is ready for Hydra again.
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
