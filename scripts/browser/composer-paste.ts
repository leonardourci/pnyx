import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { scenarioGroup, until } from '#test-harness/harness.ts'

// The browser CLI keeps its own disposable session, outside the fake agents' PATH and home.
const browserEnv = { ...process.env }
const browser = promisify(execFile)
const session = `composer-paste-${process.pid}`
const pnyx = scenarioGroup()
const script = fileURLToPath(new URL(
  './fixtures/composer-paste.js',
  import.meta.url,
))
const BROWSER_TIMEOUT_MS = 60_000

test(
  'native clipboard paste stays in the shared answer and task-note composers',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Review synthetic change',
        '--key',
        'paste',
      ],
    })
    await s.owner({
      args: [
        'task',
        'ask',
        'paste',
        '--actor',
        'hydra',
        '--to',
        'owner',
        '--question',
        'Review and merge this synthetic change?',
        '--choice',
        'Merge',
        '--choice',
        'Hold',
      ],
    })

    const browserFolder = s.folder({ name: 'browser' })
    const run = ({ args }: { args: string[] }) => browser(
      'playwright-axi',
      [
        ...args,
        '--session',
        session,
      ],
      {
        env: browserEnv,
        cwd: browserFolder,
        timeout: BROWSER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    )

    try {
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      const result = await run({
        args: [
          'run-code',
          '--filename',
          script,
        ],
      })
      assert.match(
        result.stdout,
        /paste-regression-passed/,
      )
      await until({
        what: 'the submitted answer to be saved',
        check: () => s.events().some(event => event.type === 'hydra.message' && event.data.text === 'Copied first line\nSecond line'),
      })
      assert.equal(
        s.task({ key: 'paste' }).brief,
        'Task note\nPasted second line',
      )
    } finally {
      await run({ args: ['close'] })
    }
  },
)
