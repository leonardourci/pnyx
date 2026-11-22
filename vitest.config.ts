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
    maxWorkers: '50%',
    pool: 'forks',
    execArgv: [
      '--conditions=source',
      // Worker threads started from TypeScript run Node's WebAssembly type stripper, and Node 24 can free a tiered-up
      // wrapper of its calls twice when one ends, killing the process (nodejs/node#66366); untiered calls never reach it.
      '--wasm-wrapper-tiering-budget=2147483647',
    ],
    setupFiles: ['tests/setup/environment.ts'],
    sequence: {
      // A file's own afterAll hooks, such as stopping its server, run before the setup file deletes its scratch home.
      hooks: 'stack',
      shuffle: {
        files: false,
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
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/*.test.ts'],
          sequence: { groupOrder: 2 },
          maxWorkers: '25%',
        },
      },
    ],
  },
})
