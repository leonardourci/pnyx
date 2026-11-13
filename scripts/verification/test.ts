import { spawn, type ChildProcess } from 'node:child_process'
import { constants, tmpdir } from 'node:os'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discover, isFlow } from './discover.ts'
import { holdRunLock } from './run-lock.ts'
import { createTestEnvironment } from './test-environment.ts'
import { installedFixture } from './installed-fixture.ts'
import { POSTGRES_LOG_TAIL_LINES, startPostgres } from './postgres.ts'

const PURE_CONCURRENCY = 4
const HEAVY_CONCURRENCY = 2
const MINUTE_MS = 60_000
const FLOW_TIMEOUT_MS = 5 * MINUTE_MS
const INSTALLED_FLOW = 'e2e/own-install.test.ts'
// A lane past this is stuck outside any one test; the runner then names the file it interrupted.
const LANE_TIMEOUT_MS = 60 * MINUTE_MS
// A process a signal ended exits with 128 plus the signal's number, as a shell reports it.
const SIGNAL_EXIT_BASE = 128
const STOP_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const
// Unlisted files use the bounded heavy lane until their resource use has been checked.
const PURE_TESTS = new Set([
  'web/src/hydra/action-label.test.ts',
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
  'src/app/protocol.test.ts',
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
let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined
let runningLane: ChildProcess | undefined
let stopSignal: NodeJS.Signals | undefined

// A stopped launcher ends its lane and runs no further ones, so the cleanup below still stops its cluster.
for (const signal of STOP_SIGNALS) {
  process.on(
    signal,
    () => {
      // The test runner stops its test files on SIGINT and SIGTERM only.
      const forwarded = signal === 'SIGHUP' ? 'SIGTERM' : signal
      // A second signal means the lane ignored the first.
      const laneSignal = stopSignal ? 'SIGKILL' : forwarded
      stopSignal = signal
      process.exitCode = SIGNAL_EXIT_BASE + constants.signals[signal]
      runningLane?.kill(laneSignal)
    },
  )
}

async function runLane({
  args,
  env,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
}): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
}> {
  const child = spawn(
    process.execPath,
    args,
    {
      env,
      stdio: 'inherit',
      timeout: LANE_TIMEOUT_MS,
    },
  )
  runningLane = child

  try {
    return await new Promise((
      resolve,
      reject,
    ) => {
      child.once(
        'error',
        reject,
      )
      child.once(
        'exit',
        (
          status,
          signal,
        ) => resolve({
          status,
          signal,
        }),
      )
    })
  } finally {
    runningLane = undefined
  }
}

try {
  postgres = await startPostgres({
    dir: join(
      isolated.env.TMPDIR!,
      'postgres',
    ),
  })

  for (const lane of lanes) {
    if (stopSignal) {
      break
    }

    if (!lane.files.length) {
      continue
    }

    console.log(`tests: ${lane.name}, ${lane.files.length} files, concurrency ${lane.concurrency}`)
    let testFiles = lane.files
    const env: NodeJS.ProcessEnv = {
      ...isolated.env,
      ...postgres.env,
    }

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

    try {
      const result = await runLane({
        env,
        args: [
          '--import',
          new URL(
            './test-preload.ts',
            import.meta.url,
          ).href,
          '--conditions=source',
          '--test',
          `--test-concurrency=${lane.concurrency}`,
          ...lane.nodeArgs,
          // A test past its lane's cap fails by name, and a handle it left open cannot keep its file running.
          `--test-timeout=${lane.testTimeout}`,
          '--test-force-exit',
          ...options,
          ...testFiles,
        ],
      })

      if (result.signal) {
        console.error(`tests: ${lane.name} ended by ${result.signal}`)
      }

      if (result.status !== 0 && !stopSignal) {
        const directory = mkdtempSync(join(
          tmpdir(),
          'pnyx-postgres-failure-',
        ))
        const retainedLog = join(
          directory,
          'postgres.log',
        )
        copyFileSync(
          postgres.logFile,
          retainedLog,
        )
        console.error(`Postgres log retained at ${retainedLog}:\n${readFileSync(
          retainedLog,
          'utf8',
        ).trimEnd()
          .split('\n')
          .slice(-POSTGRES_LOG_TAIL_LINES)
          .join('\n')}`)
        process.exitCode = result.status || 1
      }
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
  }
} finally {
  try {
    postgres?.stop()
  } finally {
    isolated.close()
  }
}
