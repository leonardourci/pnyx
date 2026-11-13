import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { HydraError } from './errors.ts'
import { homeDatabase, query, storable } from './postgres.ts'

const EXIT_MS = 20_000
// Postgres gives up on the lock after 5 s; the server's own wait would end only after 30.
const LOCK_ANSWER_MS = 15_000

test(
  'a home gets its own migrated database, and a failed transaction leaves nothing behind',
  () => {
    let progress = 0
    const [tables] = query({
      progress: () => {
        progress++
      },
      statements: [{ text: 'select count(*)::int as count from information_schema.tables where table_name = \'hydras\'' }],
    })
    assert.equal(
      progress,
      1,
    )
    assert.deepEqual(
      tables,
      [{ count: 1 }],
    )

    assert.throws(
      () => query({
        transaction: true,
        statements: [
          {
            text: 'insert into hydras (id, summary) values ($1, \'{}\')',
            values: ['kept-out'],
          },
          {
            text: 'insert into hydras (id, summary) values ($1, \'{}\')',
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
      { code: 'DATABASE_UNAVAILABLE' },
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
        (error: unknown) => error instanceof HydraError && error.code === 'DATABASE_UNAVAILABLE'
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

test(
  'a record with a NUL or a lone surrogate in a key or a value is stored with U+FFFD in its place',
  () => {
    const record = storable({
      value: {
        'title\u0000': 'cut 😀 at \ud83d',
        nested: [{ '\udc00': 'ok' }],
      },
    })
    assert.deepEqual(
      record,
      {
        'title�': 'cut 😀 at �',
        nested: [{ '�': 'ok' }],
      },
    )
    const [rows] = query({
      statements: [
        {
          text: 'select $1::json as value',
          values: [JSON.stringify(record)],
        },
      ],
    }) as { value: unknown }[][]
    assert.deepEqual(
      rows?.[0]?.value,
      record,
    )
  },
)

test(
  'releasing setup connections removes its idle sessions before a service restart and permits reconnecting',
  async () => {
    const { closePostgres } = await import('./postgres.ts')
    const pid = query({ statements: [{ text: 'select pg_backend_pid() as pid' }] })[0]![0]!.pid
    await closePostgres()
    const sessions = query({
      statements: [
        {
          text: 'select pid from pg_stat_activity where pid = $1',
          values: [pid],
        },
      ],
    })[0]
    assert.deepEqual(
      sessions,
      [],
    )
    assert.notEqual(
      query({ statements: [{ text: 'select pg_backend_pid() as pid' }] })[0]![0]!.pid,
      pid,
    )
  },
)

test(
  'transaction telemetry reports connection wait and commit separately from statement execution',
  () => {
    let timings: import('./postgres.ts').QueryTimings | undefined
    const started = performance.now()
    query({
      transaction: true,
      statements: [{ text: 'select pg_sleep(0.05)' }],
      timed: ({ timings: measured }) => {
        timings = measured
      },
    })
    assert.ok(timings)
    assert.ok(timings.connectionWaitMs >= 0)
    assert.ok(timings.commitMs >= 0)
    assert.ok(
      performance.now() - started - timings.connectionWaitMs - timings.commitMs >= 40,
      'statement execution is outside connection and commit timing',
    )
  },
)

test(
  'a database from #378 migrates its queue without losing events or Hydra state',
  async () => {
    const { readFileSync } = await import('node:fs')
    const { randomUUID } = await import('node:crypto')
    const database = `migration_${randomUUID().replaceAll(
      '-',
      '',
    )}`
    const admin = new pg.Client({ database: 'postgres' })
    await admin.connect()
    await admin.query(`create database ${database}`)
    const old = new pg.Client({ database })
    await old.connect()

    try {
      await old.query(readFileSync(
        new URL(
          './fixtures/postgres-v1.sql',
          import.meta.url,
        ),
        'utf8',
      ))
      await old.query('insert into hydras (id, seq, summary, queue) values (\'lab\', 7, \'{}\', \'{"waiting":["one"],"reading":[]}\')')
      const rows = query({
        url: `postgres://${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${database}`,
        statements: [{ text: 'select seq, value from hydras join hydra_queues on hydras.id = hydra_queues.hydra_id where id = \'lab\'' }],
      })[0]
      assert.deepEqual(
        rows,
        [
          {
            seq: '7',
            value: {
              waiting: ['one'],
              reading: [],
            },
          },
        ],
      )
      const published = ({ name }: { name: string }) => query({
        url: `postgres://${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${name}`,
        statements: [{ text: 'select tablename, attnames::text[] as attnames, rowfilter from pg_publication_tables where pubname = \'pnyx_page\' order by tablename' }],
      })[0]
      const fresh = `fresh_${randomUUID().replaceAll(
        '-',
        '',
      )}`
      await admin.query(`create database ${fresh}`)
      const created = new pg.Client({ database: fresh })
      await created.connect()
      await created.query(readFileSync(
        new URL(
          './schema.sql',
          import.meta.url,
        ),
        'utf8',
      ))
      await created.end()
      assert.deepEqual(
        published({ name: database }),
        published({ name: fresh }),
        'a migrated database replicates exactly what a new one does: no events, and only the columns and keys the page reads',
      )
      assert.equal(
        published({ name: database }).some(row => row.tablename === 'events'),
        false,
      )
      await admin.query(`drop database ${fresh} with (force)`)
    } finally {
      await old.end()
      await admin.query(`drop database ${database} with (force)`)
      await admin.end()
    }
  },
)

test(
  'migration removes only debug repeats and transcript copies, preserves all other types and Activity, and is repeatable',
  async t => {
    const {
      readFileSync,
      readdirSync,
    } = await import('node:fs')
    const { randomUUID } = await import('node:crypto')
    const { EVENT_TYPES } = await import('#app/model.ts')
    const {
      openLogs,
      closeLogs,
      flushLogs,
      logsDir,
    } = await import('#app/diagnostics.ts')
    openLogs()
    t.after(() => closeLogs())
    const database = `prune_${randomUUID().replaceAll(
      '-',
      '',
    )}`
    const admin = new pg.Client({ database: 'postgres' })
    await admin.connect()
    await admin.query(`create database ${database}`)
    const old = new pg.Client({ database })
    await old.connect()
    const backup = join(
      process.env.PNYX_HOME!,
      'original-events.jsonl',
    )
    writeFileSync(
      backup,
      'original JSONL backup stays unchanged\n',
    )
    const beforeBackup = readFileSync(backup)

    try {
      await old.query(readFileSync(
        new URL(
          './fixtures/postgres-v1.sql',
          import.meta.url,
        ),
        'utf8',
      ))

      for (const hydraId of [
        'lab',
        'another',
      ]) {
        await old.query(
          'insert into hydras (id, seq, summary) values ($1, $2, \'{}\')',
          [
            hydraId,
            EVENT_TYPES.length,
          ],
        )

        for (const [
          index,
          type,
        ] of EVENT_TYPES.entries()) {
          const event = {
            id: `event-${index}`,
            seq: index + 1,
            type,
            data: {
              source: {
                adapter: 'hooks',
                objectId: 'worker',
                generation: 2 ** 40,
                observedAt: '2026-11-13T12:00:00.000Z',
              },
            },
          }
          await old.query(
            'insert into events (hydra_id, seq, id, type, at, actor, card_id, data) values ($1,$2,$3,$4,$5,\'test\',$6,$7)',
            [
              hydraId,
              event.seq,
              event.id,
              type,
              '2026-11-13T12:00:00.000Z',
              index % 2 ? 'task-a' : 'task-b',
              event,
            ],
          )

          if (type !== 'card.observed' && type !== 'chat.message') {
            await old.query(
              'insert into card_updates (hydra_id, card_id, seq) values ($1,$2,$3)',
              [
                hydraId,
                index % 2 ? 'task-a' : 'task-b',
                event.seq,
              ],
            )
          }
        }
      }

      const surviving = 'select * from events where type not in (\'card.observed\', \'chat.message\') order by hydra_id, seq'
      const activity = 'select * from card_updates order by hydra_id, card_id, seq'
      const beforeEvents = (await old.query(surviving)).rows
      const beforeActivity = (await old.query(activity)).rows
      const url = `postgres://${process.env.PGUSER}@${process.env.PGHOST}:${process.env.PGPORT}/${database}`

      for (let attempt = 0; attempt < 2; attempt++) {
        const results = query({
          url,
          statements: [
            { text: surviving },
            { text: activity },
            { text: 'select count(*)::int as count from events where type in (\'card.observed\', \'chat.message\')' },
          ],
        })
        assert.deepEqual(
          results[0],
          beforeEvents,
        )
        assert.deepEqual(
          results[1],
          beforeActivity,
        )
        assert.deepEqual(
          results[2],
          [{ count: 0 }],
        )
      }

      await flushLogs()
      const pruned = readdirSync(logsDir()).flatMap(name => readFileSync(
        join(
          logsDir(),
          name,
        ),
        'utf8',
      ).split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)))
        .filter(line => line.operation === 'events.pruned' && [
          'lab',
          'another',
        ].includes(line.hydraId))
      assert.deepEqual(
        pruned.map(line => [
          line.hydraId,
          line.count,
        ]).sort(),
        [
          [
            'another',
            2,
          ],
          [
            'lab',
            2,
          ],
        ],
      )
      assert.deepEqual(
        readFileSync(backup),
        beforeBackup,
      )
      assert.ok((await old.query('select generation from source_observations')).rows.every(row => row.generation === 2 ** 40))
    } finally {
      await old.end()
      await admin.query(`drop database ${database} with (force)`)
      await admin.end()
    }
  },
)
