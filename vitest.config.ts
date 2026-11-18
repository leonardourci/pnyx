import { defineConfig } from 'vitest/config'

// Source files resolve their #imports to .ts through the `source` condition, as `node --conditions=source` does.
const conditions = ['source']
const BROWSER_TIMEOUT_MS = 120_000

export default defineConfig({
  resolve: { conditions },
  ssr: {
    resolve: {
      conditions,
      externalConditions: conditions,
    },
  },
  test: {
    provide: { uiProfile: process.env.VITE_PNYX_PROFILE === '1' },
    pool: 'forks',
    execArgv: [
      '--conditions=source',
      // Worker threads started from TypeScript run Node's WebAssembly type stripper, and Node 24 can free a tiered-up
      // wrapper of its calls twice when one ends, killing the process (nodejs/node#66366); untiered calls never reach it.
      '--wasm-wrapper-tiering-budget=2147483647',
    ],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/environment.ts'],
    // A test that needs another one's leftovers fails at once; --sequence.seed=<printed seed> repeats an order.
    sequence: {
      // A file's own afterAll hooks, such as stopping its server, run before the setup file deletes its scratch home.
      hooks: 'stack',
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
          exclude: ['tests/e2e/performance.test.ts'],
          // A browser journey starts zero-cache and Chrome, which a loaded machine slows most.
          testTimeout: BROWSER_TIMEOUT_MS,
          hookTimeout: BROWSER_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: 'performance',
          include: process.env.VITE_PNYX_PROFILE === '1' ? ['tests/e2e/performance.test.ts'] : [],
          testTimeout: BROWSER_TIMEOUT_MS,
          hookTimeout: BROWSER_TIMEOUT_MS,
        },
      },
    ],
  },
})
