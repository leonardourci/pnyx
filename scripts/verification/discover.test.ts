import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { discoverTests, isScenario, selectTests } from './discover.ts'

test(
  'discovery finds every test file in the repository',
  () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.test.ts',
      ],
      { encoding: 'utf8' },
    ).trim()
      .split('\n')
      .sort()

    assert.deepEqual(
      discoverTests(),
      files,
    )
  },
)

test(
  'unit and scenarios split the discovered files without overlap',
  () => {
    const unit = selectTests({ input: 'unit' })
    const scenarios = selectTests({ input: 'scenarios' })

    assert.deepEqual(
      [
        ...unit,
        ...scenarios,
      ].sort(),
      discoverTests(),
    )
    assert.ok(scenarios.includes('test/scenarios/hydra.test.ts'))
    assert.ok(scenarios.includes('scripts/verification/verify.scenario.test.ts'))
    assert.ok(unit.includes('scripts/verification/marker.test.ts'))
  },
)

test(
  'scenario and journey files are scenarios wherever they sit',
  () => {
    assert.deepEqual(
      [
        'test/scenarios/tasks.test.ts',
        'src/tasks/columns.scenario.test.ts',
        'e2e/page-journeys.e2e.test.ts',
        'src/tasks/columns.test.ts',
        'test/chat-browser.test.ts',
      ].map(file => isScenario({ file })),
      [
        true,
        true,
        true,
        false,
        false,
      ],
    )
  },
)
