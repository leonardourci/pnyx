import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { discover, isFlow } from './discover.ts'
import { holdRunLock } from './run-lock.ts'
import { createTestEnvironment } from './test-environment.ts'
import { installedFixture } from './installed-fixture.ts'

const PURE_CONCURRENCY = 4
const HEAVY_CONCURRENCY = 2
const MINUTE_MS = 60_000
const FLOW_TIMEOUT_MS = 5 * MINUTE_MS
const INSTALLED_FLOW = 'e2e/own-install.test.ts'
// A lane past this is stuck outside any one test; the runner then names the file it interrupted.
const LANE_TIMEOUT_MS = 60 * MINUTE_MS
// Unlisted files use the bounded heavy lane until their resource use has been checked.
const PURE_TESTS = new Set([
  'web/src/hydra/action-label.test.ts',
  'web/src/tasks/card-open.test.ts',
  'web/src/tasks/card-states.test.ts',
  'web/src/hydra/chat.test.ts',
  'web/src/hydra/conversation.test.ts',
  'src/tasks/decide.test.ts',
  'src/tasks/decisions.test.ts',
  'src/tasks/dependencies.test.ts',
  'src/cli/help.test.ts',
  'web/src/hydra/draft.test.ts',
  'src/preferences/keyboard.test.ts',
  'src/task-sources/lavish-output.test.ts',
  'scripts/verification/marker.test.ts',
  'src/memory/memory-budgets.test.ts',
  'web/src/workers/model-picker.test.ts',
  'web/src/tasks/optimistic.test.ts',
  'src/tasks/owner-ask.test.ts',
  'src/workers/permissions.test.ts',
  'web/src/hydra/pnyx-action.test.ts',
  'src/workers/presence.test.ts',
  'src/app/reducer.test.ts',
  'src/tasks/tasks.test.ts',
  'src/workers/usage-limits.test.ts',
  'src/hydra/wake-reasons.test.ts',
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
    testTimeout: FLOW_TIMEOUT_MS,
    concurrency: 1,
    // One process, so every flow shares the one server its group starts.
    nodeArgs: ['--test-isolation=none'],
    files: files.filter(file => isFlow({ file }) && resolve(file) !== resolve(INSTALLED_FLOW)),
  },
  {
    name: 'installed flows',
    testTimeout: FLOW_TIMEOUT_MS,
    concurrency: 1,
    nodeArgs: [],
    files: files.filter(file => resolve(file) === resolve(INSTALLED_FLOW)),
  },
]
const isolated = createTestEnvironment()

try {
  for (const lane of lanes) {
    if (!lane.files.length) {
      continue
    }

    console.log(`tests: ${lane.name}, ${lane.files.length} files, concurrency ${lane.concurrency}`)
    let testFiles = lane.files
    const env = { ...isolated.env }

    if (lane.name === 'installed flows') {
      const install = installedFixture({
        root: env.TMPDIR!,
        file: INSTALLED_FLOW,
      })
      env.PNYX_TEST_INSTALL = install
      testFiles = [
        join(
          install,
          INSTALLED_FLOW,
        ),
      ]
    }

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        new URL(
          './test-preload.ts',
          import.meta.url,
        ).href,
        '--conditions=source',
        '--test',
        `--test-concurrency=${lane.concurrency}`,
        ...lane.nodeArgs,
        // A test past its lane's cap fails by name, and a handle it left open cannot keep its file
        // running.
        `--test-timeout=${lane.testTimeout}`,
        '--test-force-exit',
        ...options,
        ...testFiles,
      ],
      {
        env,
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
