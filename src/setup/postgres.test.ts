import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from '#app/home-migration.ts'
import { hydraExists } from '#app/store.ts'
import { STREAMS } from '#test-harness/streams.ts'
import { setupCheckOutput } from './check.ts'
import { setupPostgres } from './postgres.ts'

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-postgres-',
  ))
})

const waitingLog = ({ hydraId }: { hydraId: string }) => {
  const dir = hydraDir({ hydraId })
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

test(
  'setup check names Postgres first when this home cannot reach it',
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
    } finally {
      process.env.PGPORT = reachable
      process.exitCode = 0
    }
  },
)

test(
  'setup postgres --check imports each waiting Hydra and rolls it back, leaving its log as it was',
  async () => {
    const path = waitingLog({ hydraId: 'waiting' })
    const before = readFileSync(path)

    const output = await setupPostgres({ check: true })

    assert.equal(
      output.imports,
      '1 Hydras import cleanly: waiting',
    )
    assert.equal(
      hydraExists({ hydraId: 'waiting' }),
      false,
    )
    assert.deepEqual(
      readFileSync(path),
      before,
    )
  },
)

test(
  'setup postgres --check fails when a waiting Hydra would not import',
  async () => {
    const path = waitingLog({ hydraId: 'broken' })
    writeFileSync(
      path,
      `${readFileSync(
        path,
        'utf8',
      )}{"v":1,"seq":99,"id":"odd","type":"not.an.event","cardId":"x"}\n`,
    )

    await assert.rejects(
      () => setupPostgres({ check: true }),
      (error: unknown) => error instanceof HydraError && error.code === 'LOG_CORRUPT',
    )
    assert.equal(
      hydraExists({ hydraId: 'broken' }),
      false,
    )
  },
)
