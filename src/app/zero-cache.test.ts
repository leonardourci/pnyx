import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { flushLogs, logsDir } from './diagnostics.ts'
import { startServer } from '#app/server-daemon.ts'
import { localToken } from '#app/server-state.ts'
import type { RunningServer } from '#app/server-transport.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { commands } from '#app/cli.ts'
import { queries } from '#store/zero-schema.ts'
import { homeDatabase, query } from '#store/postgres.ts'
import { WebSocket as NodeSocket } from 'ws'
import { readRows, zeroReady } from '#test-harness/zero-page.ts'
import { until } from '#test-harness/harness.ts'

const QUIET_MS = 3_600_000
// Longer than zero-cache's own stop, shorter than a hang.
const STOP_MS = 15_000

const alive = ({ pid }: { pid: number }) => {
  try {
    process.kill(
      pid,
      0,
    )

    return true
  } catch {
    return false
  }
}

// Every address zero-cache's processes listen on.
const listening = ({ pid }: { pid: number }) => [
  ...execFileSync(
    'lsof',
    [
      '-nP',
      '-a',
      '-g',
      String(pid),
      '-iTCP',
      '-sTCP:LISTEN',
    ],
    { encoding: 'utf8' },
  ).matchAll(/TCP (\S+):(\d+) \(LISTEN\)/g),
].map(([
  , host,
  port,
]) => ({
  host: host!,
  port: Number(port),
}))

test(
  'the server runs zero-cache on loopback behind /zero for the page cookie only, never sends private card fields, restarts it after it dies, and stops it when it stops',
  async t => {
    const previous = process.env.PNYX_HOME
    const folder = mkdtempSync(join(
      tmpdir(),
      'pnyx-zero-cache-',
    ))
    // The live client's unescaped pnyx_0_% cleanup pattern used to match a scratch database beginning pnyx_0.
    const home = Array.from(
      { length: 4096 },
      (
        _,
        index,
      ) => join(
        folder,
        String(index),
      ),
    ).find(candidate => homeDatabase({ home: candidate }).startsWith('pnyx_0'))
    assert.ok(
      home,
      'a scratch home whose old slot name overlaps the live cleanup pattern',
    )
    process.env.PNYX_HOME = home
    const resources: { server?: RunningServer } = {}
    t.after(async () => {
      await resources.server?.close()
      process.env.PNYX_HOME = previous
      rmSync(
        folder,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const server = await startServer({
      zeroCache: true,
      wakeDelay: QUIET_MS,
      stallDelay: QUIET_MS,
      busyDelay: QUIET_MS,
    })
    resources.server = server
    const origin = `http://127.0.0.1:${server.port}`
    const cookie = `${zeroCookieName({ port: server.port })}=${localToken()}`

    const page = await fetch(`${origin}/hydra/default/`)
    assert.equal(
      page.headers.get('set-cookie'),
      `${cookie}; HttpOnly; SameSite=Strict; Path=/zero`,
    )
    assert.equal(
      (await fetch(`${origin}/zero/`)).status,
      401,
    )
    assert.equal(
      (await fetch(
        `${origin}/zero/`,
        { headers: { cookie: `${zeroCookieName({ port: server.port })}=wrong` } },
      )).status,
      401,
    )
    assert.equal(
      (await fetch(
        `${origin}/zero-query`,
        {
          method: 'POST',
          body: '[]',
        },
      )).status,
      401,
    )

    await zeroReady({
      url: `${origin}/zero/`,
      cookie,
    })
    const slots = query({
      statements: [
        {
          text: `select slot_name like 'pnyx_0_%' as live_cleanup_matches
        from pg_replication_slots where database = current_database()`,
        },
      ],
    })[0]!
    assert.ok(
      slots.length > 0,
      'Zero has a replication slot in the scratch database',
    )
    assert.equal(
      slots.some(slot => slot.live_cleanup_matches),
      false,
      'the live home must never clean up this home\'s inactive replication slot',
    )

    const listed = await readRows<{ id: string }[]>({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.hydras.list()),
    })
    assert.deepEqual(
      listed.rows.map(hydra => hydra.id),
      ['default'],
    )

    // Queued steering is private to the server and its worker: no frame the page gets may carry it.
    await commands.task([
      'create',
      '--title',
      'Steered',
      '--key',
      'steered',
    ])
    await commands.task([
      'inbox',
      'enqueue',
      'steered',
      'private-1',
      '--text',
      'SECRET-STEERING',
    ])
    await flushLogs()
    const startupLog = readdirSync(logsDir()).map(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ))
      .join('')
    assert.doesNotMatch(
      startupLog,
      /No upstream permissions deployed|zero-deploy-permissions/,
    )

    const board = await readRows<{ key: string }[]>({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.board.cards({ hydraId: 'default' })),
    })
    assert.deepEqual(
      board.rows.map(card => card.key),
      ['steered'],
    )
    assert.equal(
      JSON.stringify(board.rows).includes('SECRET-STEERING'),
      false,
    )
    assert.equal(
      board.frames.some(frame => frame.includes('SECRET-STEERING')),
      false,
    )

    const pid = server.zeroCachePid()
    assert.ok(pid)
    const ports = listening({ pid })
    assert.ok(ports.length)
    assert.deepEqual(
      [...new Set(ports.map(port => port.host))],
      ['127.0.0.1'],
    )

    // A client that skips /zero has no cookie, so the query endpoint refuses what zero-cache asks for it.
    for (const { port } of ports) {
      const direct = await readRows<unknown[]>({
        url: `http://127.0.0.1:${port}`,
        query: ({ zero }) => zero.materialize(queries.hydras.list()),
      })
      assert.deepEqual(
        direct.rows,
        [],
      )
      assert.equal(
        direct.frames.some(frame => frame.includes('"default"')),
        false,
      )
    }

    const refused = await new Promise<number | undefined>(resolve => {
      const socket = new NodeSocket(
        `ws://127.0.0.1:${server.port}/zero/sync/v1/connect`,
        { headers: { cookie: `${zeroCookieName({ port: server.port })}=wrong` } },
      )
      socket.on(
        'unexpected-response',
        (
          _request,
          response,
        ) => {
          resolve(response.statusCode)
          socket.terminate()
        },
      )
      socket.on(
        'open',
        () => {
          resolve(undefined)
          socket.close()
        },
      )
      socket.on(
        'error',
        () => undefined,
      )
    })
    assert.equal(
      refused,
      401,
    )

    // A zero-cache that dies is started again, and the page reads through the new one.
    process.kill(
      -pid,
      'SIGKILL',
    )
    await until({
      what: 'zero-cache to start again',
      check: () => server.zeroCachePid() !== undefined && server.zeroCachePid() !== pid,
    })
    await zeroReady({
      url: `${origin}/zero/`,
      cookie,
    })
    assert.deepEqual(
      (await readRows<{ id: string }[]>({
        url: `${origin}/zero`,
        cookie,
        query: ({ zero }) => zero.materialize(queries.hydras.list()),
      })).rows.map(hydra => hydra.id),
      ['default'],
    )
    const restarted = server.zeroCachePid()!

    // An open page's /zero socket must not keep the server from stopping.
    const openPage = await readRows({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.hydras.list()),
      keepOpen: true,
    })
    t.after(openPage.close)

    const closed = async () => {
      await server.close()

      return true
    }

    const stopped = await Promise.race([
      closed(),
      new Promise(resolve => setTimeout(
        () => resolve(false),
        STOP_MS,
      )),
    ])
    assert.equal(
      stopped,
      true,
    )
    resources.server = undefined
    assert.equal(
      alive({ pid: restarted }),
      false,
    )
  },
)
