import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { discover, isFlow } from './discover.ts'
import { holdRunLock } from './run-lock.ts'
import { createTestEnvironment } from './test-environment.ts'

const PURE_CONCURRENCY = 4
const HEAVY_CONCURRENCY = 2
const MINUTE_MS = 60_000
// A lane past this is stuck outside any one test; the runner then names the file it interrupted.
const LANE_TIMEOUT_MS = 60 * MINUTE_MS
// Unlisted files use the bounded heavy lane until their resource use has been checked.
const PURE_TESTS = new Set([
  'test/action-label.test.ts',
  'test/card-open.test.ts',
  'test/card-states.test.ts',
  'test/chat.test.ts',
  'test/conversation.test.ts',
  'src/tasks/decide.test.ts',
  'src/tasks/decisions.test.ts',
  'src/tasks/dependencies.test.ts',
  'src/cli/help.test.ts',
  'test/draft.test.ts',
  'src/preferences/keyboard.test.ts',
  'src/task-sources/lavish-output.test.ts',
  'scripts/verification/marker.test.ts',
  'src/memory/memory-budgets.test.ts',
  'test/model-picker.test.ts',
  'test/optimistic.test.ts',
  'src/tasks/owner-ask.test.ts',
  'test/permissions.test.ts',
  'test/pnyx-action.test.ts',
  'test/presence.test.ts',
  'src/app/reducer.test.ts',
  'src/tasks/tasks.test.ts',
  'test/usage-limits.test.ts',
  'test/wake-reasons.test.ts',
].map(file => resolve(file)))

const inputs = process.argv.slice(2)
const options = inputs.filter(input => input.startsWith('--test-name-pattern='))
const files = inputs.filter(input => !options.includes(input)).flatMap(input => {
  if (input === 'unit') {
    return discover({ lane: 'unit' })
  }

  if (input === 'scenarios') {
    return discover({ lane: 'scenarios' })
  }

  return input
})

if (!files.length) {
  throw new Error('Pass unit, scenarios, or explicit test paths')
}

// A whole lane is a full run; a few explicit files run alongside it.
if (inputs.includes('unit') || inputs.includes('scenarios')) {
  await holdRunLock({ name: 'tests' })
}

const lanes = [
  {
    name: 'pure',
    testTimeout: MINUTE_MS,
    concurrency: PURE_CONCURRENCY,
    nodeArgs: [],
    files: files.filter(file => PURE_TESTS.has(resolve(file))),
  },
  {
    name: 'process/Git',
    testTimeout: 3 * MINUTE_MS,
    concurrency: HEAVY_CONCURRENCY,
    nodeArgs: [],
    files: files.filter(file => !PURE_TESTS.has(resolve(file)) && !isFlow({ file })),
  },
  {
    name: 'flows',
    testTimeout: 5 * MINUTE_MS,
    concurrency: 1,
    // One process, so every flow shares the one server its group starts.
    nodeArgs: ['--test-isolation=none'],
    files: files.filter(file => isFlow({ file })),
  },
]
const isolated = createTestEnvironment()

try {
  for (const lane of lanes) {
    if (!lane.files.length) {
      continue
    }

    console.log(`tests: ${lane.name}, ${lane.files.length} files, concurrency ${lane.concurrency}`)
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        new URL(
          './test-preload.ts',
          import.meta.url,
        ).href,
        '--test',
        `--test-concurrency=${lane.concurrency}`,
        ...lane.nodeArgs,
        // A test past its lane's cap fails by name, and a handle it left open cannot keep its file
        // running.
        `--test-timeout=${lane.testTimeout}`,
        '--test-force-exit',
        ...options,
        ...lane.files,
      ],
      {
        env: isolated.env,
        stdio: 'inherit',
        timeout: LANE_TIMEOUT_MS,
      },
    )

    if (result.error) {
      console.error(result.error)
    }

    if (result.status !== 0) {
      process.exitCode = result.status || 1
    }
  }
} finally {
  isolated.close()
}
