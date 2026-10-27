import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { holdRunLock } from './run-lock.ts'
import { createTestEnvironment } from './test-environment.ts'

const PURE_CONCURRENCY = 4
const HEAVY_CONCURRENCY = 2
// Unlisted files use the bounded heavy lane until their resource use has been checked.
const PURE_TESTS = new Set([
  'action-label',
  'card-open',
  'card-states',
  'chat',
  'comment-markers',
  'conversation',
  'decide',
  'decisions',
  'dependencies',
  'draft',
  'keyboard',
  'lavish-output',
  'marker',
  'memory-budgets',
  'model-picker',
  'optimistic',
  'owner-ask',
  'permissions',
  'pnyx-action',
  'presence',
  'reducer',
  'tasks',
  'usage-limits',
  'wake-reasons',
].map(name => resolve(`test/${name}.test.ts`)))

function discover({ folder }: { folder: string }) {
  return readdirSync(folder).filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => `${folder}/${name}`)
}

const inputs = process.argv.slice(2)
const options = inputs.filter(input => input.startsWith('--test-name-pattern='))
const files = inputs.filter(input => !options.includes(input)).flatMap(input => {
  if (input === 'unit') {
    return discover({ folder: 'test' })
  }

  if (input === 'scenarios') {
    return discover({ folder: 'test/scenarios' })
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

const serial = ({ file }: { file: string }) => file.includes('test/scenarios/') || file.endsWith('-browser.test.ts')
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
