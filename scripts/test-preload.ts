import { createTestEnvironment } from './test-environment.ts'

const isolated = createTestEnvironment({ inherited: process.env })

// These are Node's private test transport, set by the runner after launch isolation.
for (const key of [
  'NODE_TEST_CONTEXT',
  'NODE_TEST_WORKER_ID',
]) {
  if (process.env[key] !== undefined) {
    isolated.env[key] = process.env[key]
  }
}

process.env = isolated.env
process.once(
  'exit',
  isolated.close,
)
