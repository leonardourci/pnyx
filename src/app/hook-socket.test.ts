import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '#app/server-daemon.ts'
import { socketPath } from '#app/server-state.ts'
import type { RunningServer } from '#app/server-transport.ts'
import { loadHydra } from '#app/store.ts'
import { until } from '#test-harness/harness.ts'

const QUIET_MS = 3_600_000

test(
  'a hook line on the socket is ingested by the tick its write starts, without the spool watcher',
  async t => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-hook-socket-',
    ))
    process.env.PNYX_HOME = home
    const resources: { server?: RunningServer } = {}
    t.after(async () => {
      await resources.server?.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const watch = fs.watch
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
      (...args: Parameters<typeof fs.watch>) => {
        // The spool folder's watcher never reports, so only the socket's own write can start the drain.
        if (String(args[0]).endsWith('spool')) {
          return Object.assign(
            new EventEmitter(),
            {
              close: () => {},
              unref: () => {},
              ref: () => {},
            },
          )
        }

        return watch(...args)
      },
    )
    syncBuiltinESMExports()
    resources.server = await startServer({
      wakeDelay: QUIET_MS,
      stallDelay: QUIET_MS,
      busyDelay: QUIET_MS,
    })
    const socket = createConnection(socketPath({ hydraId: 'default' }))
    await new Promise(resolve => socket.once(
      'connect',
      resolve,
    ))
    socket.end(`${JSON.stringify({
      id: 'socket-observation',
      key: 'socket',
      at: new Date().toISOString(),
      actor: 'fixture',
      card: { title: 'Socket observation' },
    })}\n`)
    const card = await until({
      what: 'the socket line in the Hydra',
      check: () => {
        const state = loadHydra({ hydraId: 'default' }).state
        const id = state.keys.socket

        return id ? state.cards[id] : undefined
      },
    })
    assert.equal(
      card.title,
      'Socket observation',
    )
  },
)
