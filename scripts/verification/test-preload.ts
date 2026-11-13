import { keepChromeOffKeychain } from '#test-harness/chrome-keychain.ts'
import { createTestEnvironment } from './test-environment.ts'

process.on(
  'warning',
  warning => {
    if (warning.name === 'MaxListenersExceededWarning') {
      throw warning
    }
  },
)

const isolated = createTestEnvironment()
keepChromeOffKeychain()

// Keep Node's private test transport, the disposable install path and the run's Postgres from the isolated launcher.
for (const key of [
  'NODE_TEST_CONTEXT',
  'NODE_TEST_WORKER_ID',
  'PNYX_TEST_INSTALL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
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
