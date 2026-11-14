import { defineConfig } from 'vitest/config'

// Source files resolve their #imports to .ts through the `source` condition, as `node --conditions=source` does.
const conditions = ['source']

export default defineConfig({
  resolve: { conditions },
  ssr: {
    resolve: {
      conditions,
      externalConditions: conditions,
    },
  },
  test: {
    pool: 'forks',
    execArgv: ['--conditions=source'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/environment.ts'],
    include: ['tests/**/*.test.ts'],
    // A bound for a stuck test, not a speed target: waits inside a test end as soon as their condition holds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
