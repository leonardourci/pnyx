import { parentPort, workerData } from 'node:worker_threads'
import { HydraError } from '#store/errors.ts'
import type { SearchAnswer, SearchInput } from './search-background.ts'
import { search } from './search.ts'

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
