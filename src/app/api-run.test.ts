import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runForRequest } from './api-run.ts'

test(
  'commands run at once for different clients each report their own exit status',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-api-run-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const run = ({ argv }: { argv: string[] }) => runForRequest({
      body: {
        argv,
        cwd: home,
        env: {},
      },
    })

    const answers = await Promise.all([
      run({ argv: ['unknown-one'] }),
      run({ argv: ['unknown-two'] }),
      run({ argv: ['--not-a-flag'] }),
    ])

    assert.deepEqual(
      answers.map(answer => answer.exitCode),
      [
        2,
        2,
        2,
      ],
    )
  },
)
