import { setImmediate } from 'node:timers/promises'
import { join } from 'node:path'
import { withWriter } from '#app/writer.ts'
import { harvestTranscripts, backfillConversations } from '#integrations/hooks/harvest.ts'
import { upgradeUnderway } from '#upgrade/queue.ts'
import { indexRuns } from './index-runs.ts'

// node:sqlite is synchronous, so the Oracle index catches up in a child as well.
export const INDEX_WORKER = join(
  import.meta.dirname,
  import.meta.url.endsWith('.ts') ? 'index-process.ts' : 'index-process.js',
)
// A first build of a long history takes seconds; this only ends a stuck one.
const INDEX_WORKER_TIMEOUT_MS = 10 * 60_000

// A worker entry that fails knowingly prints { error: { message, code, help } }.
export function workerError({ stdout }: { stdout: string }): {
  message: string
  code: string
  help?: string[]
} | undefined {
  try {
    const known = JSON.parse(stdout).error

    if (typeof known?.message === 'string' && typeof known.code === 'string') {
      return known
    }
  } catch {
    // Not JSON: the worker failed before it could say why.
  }

  return undefined
}

// The server's Oracle index catch-up, run in the index child the server starts.
export function createIndexSync({
  hydraId,
  startWorker,
}: {
  hydraId: string
  startWorker({
    file,
    timeout,
    args,
    done,
  }: {
    file: string
    timeout: number
    args: string[]
    done({
      error,
      stdout,
    }: {
      error: Error | null
      stdout: string
    }): void
  }): void
}) {
  let stopped = false

  // The index process only reads the Hydra; what it needs from transcripts is written here, by the Hydra's one writer.
  const harvestForIndex = async () => {
    try {
      withWriter({
        hydraId,
        fn: ({ writer }) => harvestTranscripts({
          writer,
          cardIds: Object.keys(writer.state.cards),
          at: new Date().toISOString(),
        }),
      })

      while (!stopped && !upgradeUnderway()) {
        const batch = withWriter({
          hydraId,
          fn: ({ writer }) => backfillConversations({
            writer,
            at: new Date().toISOString(),
          }),
        })

        if (!batch.progressed) {
          break
        }

        await setImmediate()
      }
    } catch (error) {
      console.error(`pnyx oracle index: transcripts not harvested: ${(error as Error).message}`)
    }
  }

  const historyIndex = indexRuns({
    start: async () => {
      await harvestForIndex()

      return new Promise<ReturnType<typeof workerError>>(resolve => {
        // The next change, or the restarted server, catches the index up.
        if (stopped || upgradeUnderway()) {
          resolve(undefined)

          return
        }

        startWorker({
          file: INDEX_WORKER,
          timeout: INDEX_WORKER_TIMEOUT_MS,
          args: [hydraId],
          done: ({
            error,
            stdout,
          }) => {
            if (!error) {
              return resolve(undefined)
            }

            const failure = workerError({ stdout }) ?? {
              message: error.message,
              code: 'UNKNOWN',
            }
            console.error(`pnyx oracle index: ${failure.message}`)
            resolve(failure)
          },
        })
      })
    },
  })

  return {
    ...historyIndex,
    stop() {
      stopped = true
      historyIndex.stop()
    },
  }
}
