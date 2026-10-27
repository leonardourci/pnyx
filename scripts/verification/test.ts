import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isScenario, selectTests } from './discover.ts'
import { createTestEnvironment } from './test-environment.ts'

const PURE_CONCURRENCY = 4
const HEAVY_CONCURRENCY = 2
// Unlisted files use the bounded heavy lane until their resource use has been checked.
const PURE_TESTS = new Set([
  'scripts/verification/marker.test.ts',
  'src/app/reducer.test.ts',
  'test/action-label.test.ts',
  'test/card-open.test.ts',
  'test/card-states.test.ts',
  'test/chat.test.ts',
  'test/comment-markers.test.ts',
  'test/conversation.test.ts',
  'test/decide.test.ts',
  'test/decisions.test.ts',
  'test/dependencies.test.ts',
  'test/draft.test.ts',
  'test/keyboard.test.ts',
  'test/lavish-output.test.ts',
  'test/memory-budgets.test.ts',
  'test/model-picker.test.ts',
  'test/optimistic.test.ts',
  'test/owner-ask.test.ts',
  'test/permissions.test.ts',
  'test/pnyx-action.test.ts',
  'test/presence.test.ts',
  'test/tasks.test.ts',
  'test/usage-limits.test.ts',
  'test/wake-reasons.test.ts',
].map(path => resolve(path)))

const inputs = process.argv.slice(2)
const options = inputs.filter(input => input.startsWith('--test-name-pattern='))
const files = inputs.filter(input => !options.includes(input)).flatMap(input => {
  if (input === 'unit' || input === 'scenarios') {
    return selectTests({ input })
  }

  return input
})

if (!files.length) {
  throw new Error('Pass unit, scenarios, or explicit test paths')
}

const serial = ({ file }: { file: string }) => isScenario({ file }) || file.endsWith('-browser.test.ts')
const lanes = [
  {
    name: 'pure',
    concurrency: PURE_CONCURRENCY,
    files: files.filter(file => PURE_TESTS.has(resolve(file))),
  },
  {
    name: 'process/Git',
    concurrency: HEAVY_CONCURRENCY,
    files: files.filter(file => !PURE_TESTS.has(resolve(file)) && !serial({ file })),
  },
  {
    name: 'scenarios/browser',
    concurrency: 1,
    files: files.filter(file => serial({ file })),
  },
]
const isolated = createTestEnvironment({ inherited: process.env })

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
        ...options,
        ...lane.files,
      ],
      {
        env: isolated.env,
        stdio: 'inherit',
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
