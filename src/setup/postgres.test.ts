import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { HydraError } from '#store/errors.ts'
import { homeDatabase } from '#store/postgres.ts'
import { hydraDir } from '#app/home-migration.ts'
import { hydraExists } from '#app/store.ts'
import { emptyHydra } from '#app/reducer.ts'
import { saveSettings } from '#settings/store.ts'
import { STREAMS } from '#test-harness/streams.ts'
import { setupCheck, setupCheckOutput } from './check.ts'
import { setupPostgres } from './postgres.ts'

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-postgres-',
  ))
})

const waitingLog = ({ dir }: { dir: string }) => {
  mkdirSync(
    dir,
    { recursive: true },
  )
  const path = join(
    dir,
    'events.jsonl',
  )
  copyFileSync(
    join(
      STREAMS,
      'lifecycle.jsonl',
    ),
    path,
  )

  return path
}

// A brew on PATH that only records how it was called.
function fakeBrew(): { calls: () => string } {
  const bin = mkdtempSync(join(
    tmpdir(),
    'pnyx-brew-',
  ))
  const calls = join(
    bin,
    'calls',
  )
  const brew = join(
    bin,
    'brew',
  )
  writeFileSync(
    brew,
    `#!/bin/sh\necho "$@" >> '${calls}'\n`,
  )
  chmodSync(
    brew,
    0o755,
  )
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`

  return {
    calls: () => existsSync(calls) ? readFileSync(
      calls,
      'utf8',
    ) : '',
  }
}

test(
  'setup check and the digest name Postgres first when this home cannot reach it',
  async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(
      0,
      '127.0.0.1',
      resolve,
    ))
    const { port } = closed.address() as { port: number }
    await new Promise(resolve => closed.close(resolve))
    const reachable = process.env.PGPORT
    process.env.PGPORT = String(port)

    try {
      const output = await setupCheckOutput({ hydraId: 'default' }) as {
        missing: {
          name: string
          fix: string
        }[]
      }
      assert.deepEqual(
        output.missing.map(item => [
          item.name,
          item.fix,
        ]),
        [
          [
            'postgres',
            'pnyx-axi setup postgres',
          ],
        ],
      )
      assert.equal(
        process.exitCode,
        1,
      )
      const digest = await setupCheck({
        hydraId: 'default',
        state: emptyHydra(),
      })
      assert.equal(
        digest[0]?.name,
        'postgres',
      )
    } finally {
      if (reachable === undefined) {
        delete process.env.PGPORT
      } else {
        process.env.PGPORT = reachable
      }

      process.exitCode = 0
    }
  },
)

test(
  'setup postgres --check imports each waiting Hydra and rolls it back, leaving its log and folder as they were',
  async () => {
    const home = process.env.PNYX_HOME!
    const path = waitingLog({
      dir: join(
        home,
        'boards',
        'waiting',
      ),
    })
    const before = readFileSync(path)
    const empty = join(
      home,
      'hydras',
      'empty',
    )
    mkdirSync(
      empty,
      { recursive: true },
    )
    writeFileSync(
      join(
        empty,
        'events.jsonl',
      ),
      '',
    )

    const output = await setupPostgres({
      check: true,
      allowCustomHome: false,
    })

    assert.deepEqual(
      output.imported,
      ['waiting'],
    )
    assert.equal(
      hydraExists({ hydraId: 'waiting' }),
      false,
    )
    assert.deepEqual(
      readFileSync(path),
      before,
      'the log stays in boards/, unchanged',
    )
  },
)

test(
  'an unreadable log fails the check',
  async () => {
    const path = waitingLog({ dir: hydraDir({ hydraId: 'broken' }) })
    writeFileSync(
      path,
      `${readFileSync(
        path,
        'utf8',
      )}{"v":1,"seq":99,"id":"odd","type":"not.an.event","cardId":"x"}\n`,
    )

    await assert.rejects(
      () => setupPostgres({
        check: true,
        allowCustomHome: false,
      }),
      (error: unknown) => error instanceof HydraError && error.code === 'LOG_CORRUPT',
    )
    assert.equal(
      hydraExists({ hydraId: 'broken' }),
      false,
    )
  },
)

test(
  'setup postgres leaves a ready Postgres alone, reports a refused login at once, and only checks a postgresUrl one',
  async () => {
    const path = process.env.PATH
    const user = process.env.PGUSER
    const brew = fakeBrew()

    try {
      await assert.rejects(
        () => setupPostgres({
          check: false,
          allowCustomHome: false,
        }),
        { code: 'CUSTOM_HOME_SETUP' },
      )
      const ready = await setupPostgres({
        check: false,
        allowCustomHome: true,
      })
      assert.equal(
        ready.postgres,
        'ready',
      )

      // The worker does not create a database postgresUrl names, so the URL names the one the first home made.
      const named = homeDatabase()

      // A running Postgres that refuses the role needs no start.
      process.env.PNYX_HOME = mkdtempSync(join(
        tmpdir(),
        'pnyx-postgres-role-',
      ))
      process.env.PGUSER = 'pnyx_missing_role'
      await assert.rejects(
        () => setupPostgres({
          check: false,
          allowCustomHome: true,
        }),
        { code: 'POSTGRES_UNAVAILABLE' },
      )
      process.env.PGUSER = user

      process.env.PNYX_HOME = mkdtempSync(join(
        tmpdir(),
        'pnyx-postgres-url-',
      ))
      saveSettings({
        patch: { postgresUrl: `postgres://${process.env.PGUSER}:secret@${process.env.PGHOST}:${process.env.PGPORT}/${named}` },
        meta: {
          at: new Date().toISOString(),
          actor: 'cli',
        },
      })
      const configured = await setupPostgres({
        check: false,
        allowCustomHome: false,
      })
      assert.deepEqual(
        [
          configured.postgres,
          configured.database,
        ],
        [
          'ready',
          named,
        ],
      )
      assert.equal(
        brew.calls(),
        '',
      )
    } finally {
      process.env.PATH = path
      process.env.PGUSER = user
    }
  },
)
