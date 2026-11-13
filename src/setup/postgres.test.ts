import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { hydraDir } from '#app/home-migration.ts'
import { holdHydra, hydraExists } from '#app/store.ts'
import { emptyHydra } from '#app/reducer.ts'
import type { Output } from '#app/cli-support.ts'
import { readSettings, saveSettings } from '#settings/store.ts'
import { STREAMS } from '#test-harness/streams.ts'
import { setupCheck, setupCheckOutput } from './check.ts'
import { setup } from './cli.ts'

const CHANGE_URL = 'save a corrected URL with `pnyx-axi setup postgres --url <url>`, or clear it with `pnyx-axi setup postgres --url \'\'`, then run `pnyx-axi restart`'

const env = {
  PATH: process.env.PATH,
  PGPORT: process.env.PGPORT,
  PGUSER: process.env.PGUSER,
}

const newHome = () => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-postgres-',
  ))
}

beforeEach(() => {
  newHome()
  Object.assign(
    process.env,
    env,
  )
  onPlatform({ platform: realPlatform })
  process.exitCode = 0
})

const run = async ({ args }: { args: string[] }) => await setup(args) as Output

const realPlatform = process.platform

// setup postgres starts Homebrew only on macOS; elsewhere it only checks.
function onPlatform({ platform }: { platform: NodeJS.Platform }): void {
  Object.defineProperty(
    process,
    'platform',
    { value: platform },
  )
}

async function closedPort(): Promise<number> {
  const closed = createServer()
  await new Promise<void>(resolve => closed.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const { port } = closed.address() as { port: number }
  await new Promise(resolve => closed.close(resolve))

  return port
}

const saveUrl = ({ url }: { url: string }) => saveSettings({
  patch: { postgresUrl: url },
  meta: {
    at: new Date().toISOString(),
    actor: 'cli',
  },
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
    process.env.PGPORT = String(await closedPort())
    onPlatform({ platform: 'darwin' })

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

    const output = await run({
      args: [
        'postgres',
        '--check',
      ],
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
  'setup postgres --check names every Hydra that would fail, an unreadable log and a log appended to since its import, and exits 1',
  async () => {
    const broken = waitingLog({ dir: hydraDir({ hydraId: 'broken' }) })
    appendFileSync(
      broken,
      '{"v":1,"seq":99,"id":"odd","type":"not.an.event","cardId":"x"}\n',
    )
    const grown = waitingLog({ dir: hydraDir({ hydraId: 'grown' }) })
    holdHydra({
      hydraId: 'grown',
      changed: () => undefined,
    })()
    appendFileSync(
      grown,
      '{"seq":99}\n',
    )
    waitingLog({ dir: hydraDir({ hydraId: 'waiting' }) })

    const output = await run({
      args: [
        'postgres',
        '--check',
      ],
    })

    assert.deepEqual(
      [
        output.imported,
        output.failed,
        process.exitCode,
      ],
      [
        ['waiting'],
        [
          {
            hydra: 'broken',
            error: 'events.jsonl is corrupt at byte 2782',
          },
          {
            hydra: 'grown',
            error: 'events.jsonl of Hydra grown changed after it moved to Postgres (2782 bytes then, 2793 now), so an older Pnyx wrote events Postgres does not have',
          },
        ],
        1,
      ],
    )
    assert.deepEqual(
      [
        hydraExists({ hydraId: 'broken' }),
        hydraExists({ hydraId: 'waiting' }),
      ],
      [
        false,
        false,
      ],
    )
  },
)

test(
  'setup check on a Hydra still in its events.jsonl lists the import the server makes, and imports nothing',
  async () => {
    waitingLog({ dir: hydraDir({ hydraId: 'waiting' }) })

    const output = await setupCheckOutput({ hydraId: 'waiting' }) as { missing: unknown }

    assert.deepEqual(
      output.missing,
      [
        {
          name: 'import',
          missing: 'Hydra waiting is still in its events.jsonl; the server imports it when it starts',
          by: 'owner',
          fix: 'run `pnyx-axi restart`, then `pnyx-axi setup check`',
        },
      ],
    )
    assert.equal(
      process.exitCode,
      1,
    )
    assert.equal(
      hydraExists({ hydraId: 'waiting' }),
      false,
    )
  },
)

test(
  'setup postgres leaves a ready Postgres alone, refuses to start Homebrew\'s for a custom home, and reports a refused login at once',
  async () => {
    const brew = fakeBrew()
    onPlatform({ platform: 'darwin' })

    const ready = await run({ args: ['postgres'] })
    assert.equal(
      ready.postgres,
      'ready',
      'a ready Postgres needs no change, so a custom home is not refused',
    )

    // A home keeps the connection it opened, so each Postgres below gets a home of its own.
    newHome()
    process.env.PGPORT = String(await closedPort())
    await assert.rejects(
      () => run({ args: ['postgres'] }),
      { code: 'CUSTOM_HOME_SETUP' },
    )
    process.env.PGPORT = env.PGPORT

    newHome()
    process.env.PGUSER = 'pnyx_missing_role'
    await assert.rejects(
      () => run({
        args: [
          'postgres',
          '--allow-custom-home',
        ],
      }),
      {
        code: 'POSTGRES_UNAVAILABLE',
        suggestions: ['Fix: create the role PGUSER names (your login name when unset) on this Postgres, set PGUSER and PGPASSWORD to one that signs in, or save a postgresUrl with `pnyx-axi setup postgres --url <url>`'],
      },
    )
    assert.equal(
      brew.calls(),
      '',
    )
  },
)

test(
  'off macOS setup postgres only checks, and names what to start instead of itself',
  async () => {
    const brew = fakeBrew()
    process.env.PGPORT = String(await closedPort())
    onPlatform({ platform: 'linux' })

    await assert.rejects(
      () => run({ args: ['postgres'] }),
      {
        code: 'POSTGRES_UNAVAILABLE',
        suggestions: ['Fix: start PostgreSQL 15 or newer with wal_level=logical where PGHOST and PGPORT point, then run `pnyx-axi setup check`'],
      },
    )
    assert.equal(
      brew.calls(),
      '',
    )
  },
)

test(
  'a postgresUrl Postgres is only checked, and one that cannot be reached is fixed or cleared with setup postgres --url',
  async () => {
    const brew = fakeBrew()
    onPlatform({ platform: 'darwin' })
    saveUrl({ url: `postgres://${env.PGUSER}:secret@${process.env.PGHOST}:${env.PGPORT}/pnyx_configured` })

    const configured = await run({ args: ['postgres'] })
    assert.deepEqual(
      [
        configured.postgres,
        configured.database,
      ],
      [
        'ready',
        'pnyx_configured',
      ],
    )

    // A home reads postgresUrl once, so each URL below gets a home of its own.
    newHome()
    saveUrl({ url: `postgres://pnyx_missing_role@${process.env.PGHOST}:${env.PGPORT}/pnyx_configured` })
    await assert.rejects(
      () => run({ args: ['postgres'] }),
      { suggestions: [`Fix: correct the role or password in the postgresUrl setting: ${CHANGE_URL}`] },
    )

    newHome()
    saveUrl({ url: `postgres://${env.PGUSER}@127.0.0.1:${await closedPort()}/pnyx_configured` })
    await assert.rejects(
      () => run({ args: ['postgres'] }),
      { suggestions: [`Fix: start the Postgres the postgresUrl setting names, with wal_level=logical, or ${CHANGE_URL}`] },
    )
    assert.equal(
      brew.calls(),
      '',
    )

    await assert.rejects(
      () => run({
        args: [
          'postgres',
          '--url',
          'https://127.0.0.1/pnyx_configured',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    const corrected = await run({
      args: [
        'postgres',
        '--url',
        'postgres://pnyx:secret@127.0.0.1:1/pnyx_configured',
      ],
    })
    assert.equal(
      corrected.postgresUrl,
      'postgres://pnyx:***@127.0.0.1:1/pnyx_configured',
    )
    const cleared = await run({
      args: [
        'postgres',
        '--url',
        '',
      ],
    })
    assert.deepEqual(
      [
        cleared.postgresUrl,
        readSettings().settings.postgresUrl,
      ],
      [
        'none: this home\'s own database through PGHOST, PGPORT and PGUSER',
        '',
      ],
    )
  },
)

test(
  '--check and --url belong to setup postgres alone',
  () => {
    assert.throws(
      () => setup([
        'hooks',
        '--check',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => setup([
        'check',
        '--url',
        '',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
    assert.throws(
      () => setup([
        'postgres',
        '--check',
        '--url',
        '',
      ]),
      { code: 'VALIDATION_ERROR' },
    )
  },
)
