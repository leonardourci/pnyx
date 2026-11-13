import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from './postgres.ts'

const EXIT_MS = 20_000

test(
  'a home gets its own migrated database, and a failed transaction leaves nothing behind',
  () => {
    const [tables] = query({ statements: [{ text: 'select count(*)::int as count from information_schema.tables where table_name = \'hydras\'' }] })
    assert.deepEqual(
      tables,
      [{ count: 1 }],
    )

    assert.throws(
      () => query({
        transaction: true,
        statements: [
          {
            text: 'insert into hydras (id, summary, queue) values ($1, \'{}\', \'{}\')',
            values: ['kept-out'],
          },
          {
            text: 'insert into hydras (id, summary, queue) values ($1, \'{}\', \'{}\')',
            values: ['kept-out'],
          },
        ],
      }),
      { code: 'CONFLICT' },
    )
    const [rows] = query({ statements: [{ text: 'select id from hydras' }] })
    assert.deepEqual(
      rows,
      [],
    )
  },
)

test(
  'a command that used Postgres exits when its work is done',
  () => {
    // A script file, not -e: the worker inherits this process's flags, and --input-type would stop it from starting.
    const script = join(
      mkdtempSync(join(
        tmpdir(),
        'pnyx-exit-',
      )),
      'query.mjs',
    )
    writeFileSync(
      script,
      `const { query } = await import(${JSON.stringify(new URL(
        './postgres.ts',
        import.meta.url,
      ).href)})\nquery({ statements: [{ text: 'select 1' }] })\n`,
    )
    const ran = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        script,
      ],
      {
        timeout: EXIT_MS,
        encoding: 'utf8',
      },
    )
    assert.equal(
      ran.signal,
      null,
      ran.stderr,
    )
    assert.equal(
      ran.status,
      0,
      ran.stderr,
    )
  },
)
