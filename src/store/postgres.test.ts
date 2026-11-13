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

test(
  'after Postgres drops the connection, the next request opens a new one and gets its own answer',
  () => {
    const [before] = query({ statements: [{ text: 'select pg_backend_pid() as pid' }] }) as { pid: number }[][]
    assert.throws(
      () => query({
        statements: [
          {
            text: 'select pg_terminate_backend(pg_backend_pid())',
          },
        ],
      }),
      { code: 'DATABASE_ERROR' },
    )
    const [after] = query({ statements: [{ text: 'select pg_backend_pid() as pid, 7 as answer' }] }) as {
      pid: number
      answer: number
    }[][]
    assert.equal(
      after?.[0]?.answer,
      7,
    )
    assert.notEqual(
      after?.[0]?.pid,
      before?.[0]?.pid,
    )
  },
)

test(
  'a database a connection string names is created on its first use',
  () => {
    const database = `named_${Date.now()}`
    const url = `postgres://${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${database}`
    const [rows] = query({
      url,
      statements: [{ text: 'select current_database() as name' }],
    }) as { name: string }[][]
    assert.equal(
      rows?.[0]?.name,
      database,
    )
  },
)
