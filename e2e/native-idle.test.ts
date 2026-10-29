import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const TIMEOUT_MS = 20_000

test(
  'application idle cleanup waits for native queued, background and unknown work',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-idle-fixture-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    // Its clock belongs to the child, so advancing it cannot move other flows' timers.
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
          'native-idle.ts',
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
      /Native cleanup waited for queued, background and unknown work/,
    )
    assert.match(
      result.stdout,
      /Application buffers retained the original image source/,
    )
  },
)
