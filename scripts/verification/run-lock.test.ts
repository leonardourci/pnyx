import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { holdRunLock } from './run-lock.ts'

const root = mkdtempSync(join(
  tmpdir(),
  'pnyx-run-lock-',
))
const lock = join(
  root,
  'lock',
)

test.after(() => rmSync(
  root,
  {
    recursive: true,
    force: true,
  },
))

test(
  'a second full run waits until the first one exits, and a dead holder never blocks',
  async () => {
    const first = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { holdRunLock } from ${JSON.stringify(new URL(
          './run-lock.ts',
          import.meta.url,
        ).href)}
        await holdRunLock({ name: 'first', path: ${JSON.stringify(lock)} })
        console.log('held')
        process.stdin.resume().once('end', () => process.exit())`,
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'inherit',
        ],
      },
    )
    const [held] = await once(
      first.stdout,
      'data',
      { signal: AbortSignal.timeout(30_000) },
    ) as [Buffer]
    assert.equal(
      held.toString().trim(),
      'held',
    )
    let waited = ''
    const second = holdRunLock({
      name: 'second',
      path: lock,
      waiting: ({ owner }) => {
        waited = owner
        // The first run exits only after the second has seen it and is waiting.
        first.stdin.end()
      },
    })

    async function failIfTaken() {
      await second
      assert.fail('the second run took the lock while the first held it')
    }

    try {
      await Promise.race([
        once(
          first,
          'exit',
        ),
        failIfTaken(),
      ])
    } finally {
      first.stdin.end()
    }

    assert.match(
      waited,
      new RegExp(`^${first.pid} first since `),
    )
    await second
    const mine = readFileSync(
      lock,
      'utf8',
    )
    assert.match(
      mine,
      new RegExp(`^${process.pid} second since `),
    )
    // A run started by the holder, as verify starts its test steps, shares the lock.
    const nested = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { holdRunLock } from ${JSON.stringify(new URL(
          './run-lock.ts',
          import.meta.url,
        ).href)}
        await holdRunLock({ name: 'nested', path: ${JSON.stringify(lock)}, waiting: () => process.exit(3) })`,
      ],
      {
        env: {
          ...process.env,
          PNYX_RUN_LOCK: mine,
        },
        timeout: 30_000,
      },
    )
    assert.equal(
      nested.status,
      0,
    )
    assert.equal(
      readFileSync(
        lock,
        'utf8',
      ),
      mine,
    )

    delete process.env.PNYX_RUN_LOCK
    const gone = spawn(
      process.execPath,
      [
        '-e',
        '',
      ],
    )
    await once(
      gone,
      'exit',
    )
    writeFileSync(
      lock,
      `${gone.pid} crashed since 2026-01-01T00:00:00.000Z`,
    )
    await holdRunLock({
      name: 'after a crash',
      path: lock,
      waiting: () => assert.fail('a dead holder blocked the run'),
    })
    assert.match(
      readFileSync(
        lock,
        'utf8',
      ),
      new RegExp(`^${process.pid} after a crash since `),
    )
  },
)
