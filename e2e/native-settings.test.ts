import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const TIMEOUT_MS = 20000

test(
  'failed live settings wait for background, queued and unknown native work before retirement',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-settings-fixture-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const result = await run(
      process.execPath,
      [
        '--conditions=source',
        join(
          import.meta.dirname,
          '..',
          'src',
          'test-harness',
          'fixtures',
          'native-settings.ts',
        ),
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          PNYX_HOME: join(
            root,
            'pnyx',
          ),
          CLAUDE_CONFIG_DIR: join(
            root,
            'claude',
          ),
          CODEX_HOME: join(
            root,
            'codex',
          ),
        },
        timeout: TIMEOUT_MS,
      },
    )
    assert.match(
      result.stdout,
      /Rejected live settings retained background, queued and unknown native work until settled/,
    )
  },
)
