import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { discover, FLOW_FOLDERS, isFlow } from './discover.ts'

const ROOT = new URL(
  '../..',
  import.meta.url,
).pathname

test(
  'the unit and flow lanes together find every test file once',
  () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '*.test.ts',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(file => file && existsSync(`${ROOT}${file}`))
      .sort()
    const scenarios = discover({ lane: 'scenarios' })

    assert.deepEqual(
      files.filter(file => file.includes('/fixtures/')),
      [],
    )
    assert.deepEqual(
      [
        ...discover({ lane: 'unit' }),
        ...scenarios,
      ].sort(),
      files,
    )
    assert.ok(scenarios.length > 0)
    assert.ok(scenarios.every(file => FLOW_FOLDERS.some(folder => file.startsWith(folder))))
  },
)

test(
  'a named file is a flow by its folder, however the path is written',
  () => {
    assert.equal(
      isFlow({ file: 'test/scenarios/tasks.test.ts' }),
      true,
    )
    assert.equal(
      isFlow({ file: `${process.cwd()}/test/scenarios/tasks.test.ts` }),
      true,
    )
    assert.equal(
      isFlow({ file: './test/scenarios/tasks.test.ts' }),
      true,
    )
    assert.equal(
      isFlow({ file: 'test/reducer.test.ts' }),
      false,
    )
  },
)
