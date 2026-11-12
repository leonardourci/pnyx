import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { SOURCE_CONDITIONS } from '#app/source-conditions.ts'
import type { Query } from './model.ts'
import { search } from './search.ts'
import { HydraError } from '#store/errors.ts'

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

export function searchInBackground({
  hydraId,
  query,
}: SearchInput): Promise<ReturnType<typeof search>> {
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
    worker.once(
      'message',
      (found: SearchAnswer) => {
        answer = found
      },
    )
    worker.once(
      'error',
      reject,
    )
    worker.once(
      'exit',
      code => {
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
