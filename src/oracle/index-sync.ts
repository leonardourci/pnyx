import { join } from 'node:path'
import { log } from '#app/diagnostics.ts'
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

  const historyIndex = indexRuns({
    start: () => new Promise<ReturnType<typeof workerError>>(resolve => {
      // The next change, or the restarted server, catches the index up.
      if (stopped || upgradeUnderway()) {
        resolve(undefined)

        return
      }

      const started = performance.now()
      startWorker({
        file: INDEX_WORKER,
        timeout: INDEX_WORKER_TIMEOUT_MS,
        args: [hydraId],
        done: ({
          error,
          stdout,
        }) => {
          let failure: ReturnType<typeof workerError>

          if (error) {
            failure = workerError({ stdout }) ?? {
              message: error.message,
              code: 'UNKNOWN',
            }
            log({
              level: 'error',
              operation: 'oracle.index',
              hydraId,
              code: failure.code,
              error: failure.message,
              ms: performance.now() - started,
            })
          } else {
            log({
              operation: 'oracle.index',
              hydraId,
              ms: performance.now() - started,
            })
          }

          resolve(failure)
        },
      })
    }),
  })

  return {
    ...historyIndex,
    stop() {
      stopped = true
      historyIndex.stop()
    },
  }
}
