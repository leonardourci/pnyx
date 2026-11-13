import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '#app/server-daemon.ts'
import { localToken } from '#app/server-state.ts'
import type { RunningServer } from '#app/server-transport.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries, schema } from '#store/zero-schema.ts'
import { Zero } from '@rocicorp/zero'
import { WebSocket as NodeSocket } from 'ws'

const QUIET_MS = 3_600_000
// zero-cache's first start copies the home's tables into its replica before it reports ready.
// Longer than zero-cache's own stop, shorter than a hang.
const STOP_MS = 15_000
const READY_MS = 60_000
const POLL_MS = 100

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

// The page's read: a Zero client on the same origin, whose WebSocket carries the cookie as a browser's would.
async function readHydras({
  origin,
  cookie,
  keepOpen = false,
}: {
  origin: string
  cookie: string
  // Leaves the client connected, as an open page is, and returns how to close it.
  keepOpen?: boolean
}) {
  const browserSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends NodeSocket {
    // eslint-disable-next-line pnyx/object-params -- the WebSocket constructor owns this signature.
    constructor(
      address: string,
      protocols?: string | string[],
    ) {
      super(
        address,
        protocols,
        { headers: { cookie } },
      )
      // A page left open sees its socket drop and its reconnects refused while the server stops.
      this.on(
        'error',
        () => undefined,
      )
    }
  } as unknown as typeof WebSocket
  const zero = new Zero({
    cacheURL: `${origin}/zero`,
    schema,
    userID: 'owner',
    kvStore: 'mem',
  })

  const close = async () => {
    await zero.close()
    globalThis.WebSocket = browserSocket
  }

  try {
    return {
      hydras: await zero.run(
        queries.hydras.list(),
        { type: 'complete' },
      ),
      close,
    }
  } finally {
    if (!keepOpen) {
      await close()
    }
  }
}

async function zeroReady({
  url,
  cookie,
}: {
  url: string
  cookie: string
}): Promise<Response> {
  for (const end = performance.now() + READY_MS; performance.now() < end;) {
    const answer = await fetch(
      url,
      { headers: { cookie } },
    )

    if (answer.status === 200) {
      return answer
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
  }

  throw new Error('timed out waiting for zero-cache behind /zero')
}

test(
  'the server runs zero-cache behind /zero for the page cookie only, answers its queries, and stops it when it stops',
  async t => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-zero-cache-',
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
    const { hydras } = await readHydras({
      origin,
      cookie,
    })
    assert.deepEqual(
      hydras.map(hydra => hydra.id),
      ['default'],
    )
    const pid = server.zeroCachePid()
    assert.ok(pid)
    // An open page's /zero socket must not keep the server from stopping.
    const openPage = await readHydras({
      origin,
      cookie,
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
      alive({ pid }),
      false,
    )
  },
)
