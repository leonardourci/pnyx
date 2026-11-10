import { execFile, type ChildProcess } from 'node:child_process'
import type { ReplyState } from '#workers/model.ts'
import { INDEX_WORKER } from '#oracle/index-sync.ts'
import { log } from './diagnostics.ts'
import { runPageCommand } from './page-command.ts'
import { MAX_BODY } from './server-transport.ts'
import { SOURCE_CONDITIONS } from './source-conditions.ts'

// A worker mid-write gets this long to finish on shutdown before it is killed.
const WORKER_GRACE_MS = 5000
// Replies and page commands run in the server itself; only the Oracle index catch-up runs in a child.
const REPLY_WORKER = 'reply'
export const COMMAND_WORKER = 'command'
const REPLY_WORKER_TIMEOUT_MS = 130_000

// The commands one mounted Hydra runs for its pages and its scheduler, and the children it waits for at shutdown.
export function createServerWorkers({
  hydraId,
  closed,
}: {
  hydraId: string
  closed(): boolean
}) {
  // Children the server waits for at shutdown; the value says whether shutdown may kill one (the index catch-up, which the next run repeats).
  const workers = new Map<ChildProcess, boolean>()
  const inProcess = new Set<Promise<void>>()

  const startWorker = ({
    args,
    file = REPLY_WORKER,
    timeout = REPLY_WORKER_TIMEOUT_MS,
    done,
  }: {
    args: string[]
    file?: string
    timeout?: number
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

    if (file === REPLY_WORKER || file === COMMAND_WORKER) {
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

      return
    }

    const child = execFile(
      process.execPath,
      [
        ...SOURCE_CONDITIONS,
        file,
        ...args,
      ],
      {
        timeout,
        maxBuffer: MAX_BODY,
      },
      (
        error,
        stdout,
      ) => done({
        error,
        stdout,
      }),
    )
    workers.set(
      child,
      file === INDEX_WORKER,
    )
    child.once(
      'close',
      () => workers.delete(child),
    )
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

  // No worker starts once closed is set, so the map only shrinks while this waits.
  // A send is never killed here: its receipt is written after the send, and a queued reply without one stays stuck.
  const joinWorkers = async () => {
    const killer = setTimeout(
      () => workers.forEach((
        killable,
        child,
      ) => killable && child.kill('SIGKILL')),
      WORKER_GRACE_MS,
    )

    while (workers.size > 0) {
      await new Promise(resolve => [...workers.keys()][0]!.once(
        'close',
        resolve,
      ))
    }

    await Promise.all(inProcess)

    clearTimeout(killer)
  }

  // Resends tried so far, by retry id and time, so one that failed before its receipt still counts.
  const triedResends = new Map<string, number>()

  // A resend goes through the reply command in a child, like a send from the page.
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
