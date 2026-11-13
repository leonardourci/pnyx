import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '#app/server-daemon.ts'
import type { RunningServer } from '#app/server-transport.ts'
import { query } from '#store/postgres.ts'
import { openPage, until } from '#test-harness/harness.ts'

const QUIET_MS = 3_600_000

test(
  'a server started again reports the last upgrade check, so the page keeps its notice',
  async t => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-upgrade-status-',
    ))
    process.env.PNYX_HOME = home
    const resources: { server?: RunningServer } = {}
    t.after(async () => {
      await resources.server?.close()
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const checkedAt = '2026-11-13T00:00:00.000Z'
    query({
      statements: [
        {
          text: 'insert into upgrade_status (id, available, checked_at) values (\'current\', true, $1)',
          values: [checkedAt],
        },
      ],
    })

    resources.server = await startServer({
      wakeDelay: QUIET_MS,
      stallDelay: QUIET_MS,
      busyDelay: QUIET_MS,
    })

    const page = await openPage({
      port: resources.server.port,
      hydraId: 'default',
    })
    t.after(page.close)
    assert.deepEqual(
      await until({
        what: 'the saved upgrade check on the page',
        check: () => page.upgrades[0],
      }),
      {
        available: true,
        checkedAt,
      },
    )
  },
)
