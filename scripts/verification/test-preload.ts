import { createTestEnvironment } from './test-environment.ts'

const isolated = createTestEnvironment()

// Preserve Node's private test transport and the disposable install path from the isolated launcher.
for (const key of [
  'NODE_TEST_CONTEXT',
  'NODE_TEST_WORKER_ID',
  'PNYX_TEST_INSTALL',
]) {
  if (process.env[key] !== undefined) {
    isolated.env[key] = process.env[key]
  }
}

for (const key of Object.keys(process.env)) {
  if (!(key in isolated.env)) {
    delete process.env[key]
  }
}

Object.assign(
  process.env,
  isolated.env,
)
process.once(
  'exit',
  isolated.close,
)
