import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { discover } from './discover.ts'

test(
  'the unit and flow lanes together find every tracked test file once',
  () => {
    const tracked = execFileSync(
      'git',
      [
        'ls-files',
        '*.test.ts',
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter(file => !file.includes('/fixtures/'))
      .sort()
    const unit = discover({ lane: 'unit' })
    const scenarios = discover({ lane: 'scenarios' })

    assert.deepEqual(
      [
        ...unit,
        ...scenarios,
      ].sort(),
      tracked,
    )
    assert.equal(
      unit.filter(file => scenarios.includes(file)).length,
      0,
    )
    assert.ok(scenarios.length > 0 && scenarios.every(file => file.startsWith('test/scenarios/') || file.startsWith('e2e/')))
  },
)
