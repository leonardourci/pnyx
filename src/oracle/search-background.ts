import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { log } from '#app/diagnostics.ts'
import { SOURCE_CONDITIONS } from '#app/source-conditions.ts'
import type { Query } from './model.ts'
import { search } from './search.ts'
import { HydraError } from '#store/errors.ts'

const searches = new Map<string, Promise<ReturnType<typeof search>>>()

interface SearchInput {
  hydraId: string
  query: Query
}

type SearchAnswer = { result: ReturnType<typeof search> } | {
  error: {
    message: string
    code: string
    help?: string[]
  }
}

if (!isMainThread) {
  const input: SearchInput = workerData

  try {
    parentPort?.postMessage({ result: search(input) } satisfies SearchAnswer)
  } catch (error) {
    parentPort?.postMessage({
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof HydraError ? error.code : 'UNKNOWN',
        help: error instanceof HydraError ? error.help : undefined,
      },
    } satisfies SearchAnswer)
  }
}

export async function searchInBackground({
  hydraId,
  query,
  signal,
}: SearchInput & { signal?: AbortSignal }): Promise<ReturnType<typeof search>> {
  const previous = searches.get(hydraId)

  const next = async () => {
    try {
      await previous
    } catch {
      // The previous caller receives its failure; later searches still run.
    }

    if (signal?.aborted) {
      throw new HydraError({
        message: 'Oracle search cancelled',
        code: 'CANCELLED',
      })
    }

    return runSearch({
      hydraId,
      query,
      signal,
    })
  }

  const pending = next()
  searches.set(
    hydraId,
    pending,
  )

  try {
    return await pending
  } finally {
    if (searches.get(hydraId) === pending) {
      searches.delete(hydraId)
    }
  }
}

function runSearch({
  hydraId,
  query,
  signal,
}: SearchInput & { signal?: AbortSignal }): Promise<ReturnType<typeof search>> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const worker = new Worker(
      new URL(import.meta.url),
      {
        execArgv: SOURCE_CONDITIONS,
        workerData: {
          hydraId,
          query,
        },
      },
    )
    let answer: SearchAnswer | undefined
    let failure: Error | undefined

    const cancel = () => {
      // Exit settles the request, so the next scan starts after this worker has stopped.
      worker.terminate().catch((error: Error) => {
        log({
          level: 'error',
          operation: 'oracle.cancel',
          hydraId,
          error,
        })
      })
    }

    signal?.addEventListener(
      'abort',
      cancel,
      { once: true },
    )
    worker.once(
      'message',
      (found: SearchAnswer) => {
        answer = found
      },
    )
    worker.once(
      'error',
      (error: Error) => {
        failure = error
      },
    )
    worker.once(
      'exit',
      code => {
        signal?.removeEventListener(
          'abort',
          cancel,
        )

        if (signal?.aborted) {
          reject(new HydraError({
            message: 'Oracle search cancelled',
            code: 'CANCELLED',
          }))

          return
        }

        if (failure) {
          reject(failure)

          return
        }

        if (code !== 0 || !answer) {
          reject(new Error(`Oracle search worker exited with code ${code}`))

          return
        }

        if ('error' in answer) {
          reject(new HydraError(answer.error))

          return
        }

        resolve(answer.result)
      },
    )
  })
}
