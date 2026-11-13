import type { ReplyState } from '#workers/model.ts'
import { log } from './diagnostics.ts'
import { runPageCommand } from './page-command.ts'

// The commands one mounted Hydra runs for its pages and its scheduler.
export function createServerWorkers({
  hydraId,
  closed,
}: {
  hydraId: string
  closed(): boolean
}) {
  const inProcess = new Set<Promise<void>>()

  const startWorker = ({
    args,
    done,
  }: {
    args: string[]
    done: ({
      error,
      stdout,
    }: {
      error: Error | null
      stdout: string
    }) => void
  }) => {
    if (closed()) {
      done({
        error: new Error('Pnyx is shutting down'),
        stdout: JSON.stringify({
          error: {
            message: 'Pnyx is shutting down',
            code: 'UNAVAILABLE',
          },
        }),
      })

      return
    }

    // runPageCommand reports its own failures in its answer, so this promise never rejects.
    const answer = async () => {
      const {
        failed,
        stdout,
      } = await runPageCommand({ argv: args })
      done({
        error: failed ? new Error(`${args[0]} failed`) : null,
        stdout,
      })
    }

    const running = answer().finally(() => inProcess.delete(running))
    inProcess.add(running)
  }

  const runWorker = ({ args }: { args: string[] }) => new Promise<{ stdout: string }>((
    resolve,
    reject,
  ) => {
    if (closed()) {
      return reject(new Error('Pnyx is shutting down'))
    }

    startWorker({
      args,
      done: ({
        error,
        stdout,
      }) => error ? reject(error) : resolve({ stdout }),
    })
  })

  const joinWorkers = async () => {
    await Promise.all(inProcess)
  }

  // Resends tried so far, by retry id and time, so one that failed before its receipt still counts.
  const triedResends = new Map<string, number>()

  // A resend uses the same reply command as the page.
  const resendReply = async ({
    card,
    text,
    retry,
  }: {
    card: string
    text: string
    retry: string
  }): Promise<ReplyState> => {
    try {
      const { stdout } = await runWorker({
        args: [
          'reply',
          card,
          // A text starting with a dash would otherwise read as an option.
          `--text=${text}`,
          '--idempotency-key',
          retry,
          '--hydra',
          hydraId,
          '--actor',
          'pnyx',
        ],
      })
      const receipt = JSON.parse(stdout) as { reply?: { state?: ReplyState } }
      const state = receipt.reply?.state

      if (!state) {
        return 'delivery_unknown'
      }

      return state
    } catch (error) {
      log({
        level: 'error',
        operation: 'reply.resend',
        hydraId,
        taskId: card,
        correlationId: retry,
        error,
      })

      return 'delivery_unknown'
    }
  }

  return {
    startWorker,
    runWorker,
    joinWorkers,
    triedResends,
    resendReply,
  }
}
