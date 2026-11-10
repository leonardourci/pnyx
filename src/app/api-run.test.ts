import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runForRequest } from './api-run.ts'
import { closeLogs, logsDir, openLogs } from './diagnostics.ts'

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

test(
  'a command line from the owner’s terminal is logged against the Hydra it runs on and as the CLI’s',
  async t => {
    openLogs()
    t.after(() => closeLogs())
    const run = ({
      argv,
      env,
    }: {
      argv: string[]
      env: Record<string, string>
    }) => runForRequest({
      body: {
        argv,
        cwd: '/',
        env,
      },
    })
    await run({
      argv: ['unknown-owner'],
      env: {},
    })
    await run({
      argv: ['unknown-worker'],
      env: {
        PNYX_ACTOR: 'worker:first',
        PNYX_HYDRA: 'lab',
      },
    })
    const lines = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .filter(line => line.operation === 'command.cli')
    assert.deepEqual(
      lines.map(line => [
        line.hydraId,
        line.actor,
      ]),
      [
        [
          'default',
          'cli',
        ],
        [
          'lab',
          'worker:first',
        ],
      ],
    )
  },
)
