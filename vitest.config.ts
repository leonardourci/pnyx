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
    // Files and the tests in each run in a random order, so a test that needs another one's leftovers fails at once.
    // A failing run's order repeats with --sequence.seed=<the seed it printed>.
    sequence: {
      shuffle: {
        files: true,
        tests: true,
      },
    },
    // Bounds for a stuck test, not speed targets: every wait ends as soon as its condition holds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/*.test.ts'],
          // A browser journey starts zero-cache and Chrome, which a loaded machine slows most.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
