import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { HydraError } from './errors.ts'
import { homeDatabase, query } from './postgres.ts'

const EXIT_MS = 20_000
// Postgres gives up on the lock after 5 s; the server's own wait would end only after 30.
const LOCK_ANSWER_MS = 15_000

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

test(
  'a table another session keeps locked answers with an error within the lock timeout, instead of freezing the server',
  async () => {
    query({ statements: [{ text: 'select 1' }] })
    // Another process, as a psql session or a long VACUUM FULL would be, holds the lock until its stdin closes.
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import pg from 'pg'
const client = new pg.Client({ database: ${JSON.stringify(homeDatabase())} })
await client.connect()
await client.query('begin')
await client.query('lock table hydras in access exclusive mode')
process.stdout.write('locked\\n')
process.stdin.resume()
process.stdin.on('end', () => client.end())`,
      ],
      {
        cwd: new URL(
          '../..',
          import.meta.url,
        ),
        stdio: [
          'pipe',
          'pipe',
          'inherit',
        ],
      },
    )

    try {
      await new Promise<void>((
        resolve,
        reject,
      ) => {
        holder.stdout.on(
          'data',
          (chunk: Buffer) => String(chunk).includes('locked') && resolve(),
        )
        holder.once(
          'exit',
          () => reject(new Error('the lock holder exited')),
        )
      })
      const started = performance.now()
      assert.throws(
        () => query({ statements: [{ text: 'select count(*) from hydras' }] }),
        (error: unknown) => error instanceof HydraError && error.code === 'DATABASE_ERROR'
          && /lock timeout/.test(error.message),
      )
      assert.ok(performance.now() - started < LOCK_ANSWER_MS)
    } finally {
      holder.stdin.end()
      await new Promise(resolve => holder.once(
        'exit',
        resolve,
      ))
    }
  },
)

test(
  'a database another build\'s schema made is refused by name instead of failing its writes',
  async () => {
    const database = `other_schema_${Date.now()}`
    const admin = new pg.Client({ database: 'postgres' })
    await admin.connect()
    await admin.query(`create database ${database}`)
    await admin.end()
    const other = new pg.Client({ database })
    await other.connect()
    await other.query('create table hydras (id text primary key)')
    await other.end()

    assert.throws(
      () => query({
        url: `postgres://${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${database}`,
        statements: [{ text: 'select 1' }],
      }),
      (error: unknown) => error instanceof HydraError
        && error.message.includes(`database ${database} has another Pnyx build's schema`),
    )
  },
)
