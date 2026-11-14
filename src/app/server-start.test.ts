import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { hydraDir } from './home-migration.ts'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { HydraError } from '#store/errors.ts'
import { query } from '#store/postgres.ts'
import { readStream } from '#test-harness/streams.ts'
import { startServer } from './server-daemon.ts'
import { withWriter } from './writer.ts'

const QUIET_MS = 3_600_000
const READY_MS = 30_000
const POLL_MS = 50

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-start-',
  ))
})

const quiet = {
  wakeDelay: QUIET_MS,
  stallDelay: QUIET_MS,
  busyDelay: QUIET_MS,
}

async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const { port } = probe.address() as { port: number }
  await new Promise(resolve => probe.close(resolve))

  return port
}

test(
  'a server that starts while Postgres does not answer exits and lets go of its claim, so launchd or the owner can start it again',
  async () => {
    const port = process.env.PGPORT
    // A new home's first query opens its connection with the PGPORT of that moment.
    process.env.PGPORT = String(await closedPort())

    try {
      await assert.rejects(
        startServer({
          port: 0,
          ...quiet,
        }),
        (error: unknown) => error instanceof HydraError && error.code === 'DATABASE_UNAVAILABLE',
      )
    } finally {
      process.env.PGPORT = port
    }

    assert.equal(
      existsSync(join(
        process.env.PNYX_HOME!,
        'server.lock',
      )),
      false,
    )
  },
)

test(
  'a Hydra list entry that changed without an event is written to its row, which the page lists Hydras from',
  async t => {
    const server = await startServer({
      port: 0,
      ...quiet,
    })
    t.after(() => server.close())
    const summary = ({ hydraId }: { hydraId: string }) => query({
      statements: [
        {
          text: 'select summary from hydras where id = $1',
          values: [hydraId],
        },
      ],
    })[0]![0]?.summary as { id?: string } | undefined

    const until = async ({ check }: { check: () => boolean }) => {
      for (const end = performance.now() + READY_MS; !check() && performance.now() < end;) {
        await new Promise(resolve => setTimeout(
          resolve,
          POLL_MS,
        ))
      }
    }

    await until({ check: () => summary({ hydraId: 'default' })?.id === 'default' })
    // Stands in for a summary that changed with no write to its Hydra, as a Firstmate home's projects do.
    query({ statements: [{ text: 'update hydras set summary = \'{}\' where id = \'default\'' }] })
    // A new Hydra changes the list, so the server writes every entry that differs from its row.
    withWriter({
      hydraId: 'other',
      create: true,
      fn: ({ writer }) => readStream({ name: 'lifecycle' }).forEach(event => writer.append({ event })),
    })
    await until({ check: () => summary({ hydraId: 'default' })?.id === 'default' })

    assert.equal(
      summary({ hydraId: 'default' })?.id,
      'default',
    )
  },
)

test(
  'startup imports every Hydra before publishing the running server',
  async t => {
    for (const hydraId of [
      'default',
      'late-a',
      'late-b',
    ]) {
      const dir = hydraDir({ hydraId })
      mkdirSync(
        dir,
        { recursive: true },
      )
      writeFileSync(
        join(
          dir,
          'events.jsonl',
        ),
        readStream({ name: 'lifecycle' }).map(event => JSON.stringify(event))
          .join('\n') + '\n',
      )
    }

    const server = await startServer({
      port: 0,
      ...quiet,
    })
    t.after(() => server.close())
    assert.deepEqual(
      query({ statements: [{ text: 'select id from hydras order by id' }] })[0]!.map(row => String(row.id)),
      [
        'default',
        'late-a',
        'late-b',
      ],
    )
  },
)
