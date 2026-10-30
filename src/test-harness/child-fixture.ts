// A fixture in src/test-harness/fixtures/ runs the real application host in its own process, so the clock it mocks moves no other flow's timers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FIXTURE_TIMEOUT_MS = 20_000
const SETTLE_MS = 5000

// Runs the named fixture with its own homes and resolves with what it printed.
export async function runFixture({
  t,
  name,
}: {
  t: TestContext
  name: string
}) {
  const root = mkdtempSync(join(
    tmpdir(),
    `pnyx-${name}-`,
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
        'fixtures',
        `${name}.ts`,
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
      timeout: FIXTURE_TIMEOUT_MS,
    },
  )

  return result.stdout
}

// The harness's until() waits with setTimeout, which a fixture mocks; with tick, each pass also moves the mocked clock that far.
export async function settle({
  what,
  check,
  tick,
}: {
  what: string
  check(): unknown
  tick?: number
}) {
  const until = Date.now() + SETTLE_MS

  while (!check()) {
    assert.ok(
      Date.now() < until,
      what,
    )

    if (tick) {
      mock.timers.tick(tick)
    }

    await setImmediate()
  }
}
