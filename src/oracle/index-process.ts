import { HydraError } from '#store/errors.ts'
import { updateIndex } from './index.ts'

// The server catches up here: node:sqlite is synchronous, and a first build takes seconds.
try {
  process.stdout.write(JSON.stringify(updateIndex({ hydraId: process.argv[2]! })))
} catch (error) {
  process.stdout.write(JSON.stringify({
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof HydraError ? error.code : 'UNKNOWN',
    },
  }))
  process.exitCode = 1
}
