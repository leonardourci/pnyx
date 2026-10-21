import { MAX_MESSAGE_BYTES } from '../src/server/protocol.ts'
import { seedWebFixture } from './web-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { WebSocket } from 'ws'
import { HydraError } from '../src/core/model.ts'
import { allowedRequest, startServer, type RunningServer, type ServerMessage } from '../src/server/server.ts'
import { infoPath, localToken, readServer, socketPath } from '../src/server/state.ts'
import { hydraDir, loadHydra, spoolDir, spoolWrite, withWriter } from '../src/store/hydra-store.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { decidePush } from '../src/core/decide.ts'
import { indexStatus, searchPath } from '../src/oracle/index.ts'
import { writeSetting } from '../src/oracle/settings.ts'
import { stopAll, track } from './processes.ts'
import type { HydraSummary } from '../src/server/hydras.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// Waits end as soon as their condition holds; the bound only has to outlast a heavily loaded machine.
const TIMEOUT_MS = 30000
// CLI children start a fresh node process; under a parallel test run that can take far longer than a poll.
const CLI_TIMEOUT_MS = 30000

// Keeps the default-login fallback away from the real harness logins.
const noLogin = join(
  mkdtempSync(join(
    tmpdir(),
    'pnyx-no-login-',
  )),
  'missing',
)
process.env.CLAUDE_CONFIG_DIR = join(
  noLogin,
  'claude',
)
process.env.CODEX_HOME = join(
  noLogin,
  'codex',
)

let server: RunningServer | undefined
const tabs = new Set<WebSocket>()

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-server-',
  ))
})

afterEach(async () => {
  for (const ws of tabs) {
    // A refused handshake reports its own end as an error; that is expected here.
    ws.on(
      'error',
      () => {},
    )
    ws.terminate()
  }

  tabs.clear()
  await stopAll()
  await server?.close()
  server = undefined
})

const cli = ({ args }: { args: string[] }): string => {
  const out = execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    },
  )
  const token = /^token: ([a-f0-9]+)$/m.exec(out)?.[1]

  return token ? cli({
    args: [
      ...args,
      '--confirm',
      token,
    ],
  }) : out
}

const hookEvent = ({
  id,
  key,
  title,
}: {
  id: string
  key: string
  title: string
}) => ({
  id,
  key,
  at: '2026-10-13T14:00:00Z',
  actor: 'hook',
  card: { title },
})

async function until<T>({
  check,
  what,
}: {
  check: () => T | undefined
  what: string
}): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS

  for (;;) {
    const value = check()

    if (value !== undefined) {
      return value
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise(r => setTimeout(
      r,
      20,
    ))
  }
}

const seqIs = ({
  seq,
  hydraId = 'default',
}: {
  seq: number
  hydraId?: string
}) => until({
  check: () => (loadHydra({ hydraId }).state.seq === seq ? true : undefined),
  what: `seq ${seq}`,
})

async function sendToSocket({
  path,
  text,
}: {
  path: string
  text: string
}): Promise<void> {
  const conn = connect(path)
  await once(
    conn,
    'connect',
  )
  conn.end(text)
  await once(
    conn,
    'close',
  )
}

function inbox<T>() {
  const queue: T[] = []
  const waiting: (({ m }: { m: T }) => void)[] = []

  return {
    queue,
    put({ message }: { message: T }) {
      const waiter = waiting.shift()

      if (waiter) {
        waiter({ m: message })
      } else {
        queue.push(message)
      }
    },
    // A reply or agent receipt comes from a spawned CLI worker, so its wait takes CLI_TIMEOUT_MS.
    next: ({ ms = TIMEOUT_MS }: { ms?: number } = {}) =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<T>((
          resolve,
          reject,
        ) => {
          const timer = setTimeout(
            () => {
            // A wait that timed out must not swallow the message that arrives after it.
              waiting.splice(
                waiting.indexOf(waiter),
                1,
              )
              reject(new Error('timed out waiting for a message'))
            },
            ms,
          ).unref()

          const waiter = ({ m }: { m: T }) => {
            clearTimeout(timer)
            resolve(m)
          }

          waiting.push(waiter)
        }),
  }
}

type LatestMessages = Extract<ServerMessage, { type: 'latest' }>['messages']

// Last-message pushes arrive on their own queue, so the other messages keep their order.
async function tab({
  query = '',
  hydraId = 'default',
}: {
  query?: string
  hydraId?: string
} = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/hydra/${hydraId}/ws?token=${localToken()}${query.replace(
    '?',
    '&',
  )}`)
  tabs.add(ws)
  const main = inbox<ServerMessage>(), latest = inbox<LatestMessages>()
  const summaries = inbox<Extract<ServerMessage, { type: 'hydras' }>>()
  const queue = main.queue
  ws.on(
    'message',
    data => {
      const message = JSON.parse(String(data)) as ServerMessage

      if (message.type === 'latest') {
        latest.put({ message: message.messages })
      } else if (message.type === 'hydras') {
        summaries.put({ message })
      } else {
        main.put({ message })
      }
    },
  )
  await once(
    ws,
    'open',
  )
  const hello = await main.next()
  assert.equal(
    hello.type,
    'hello',
  )

  return {
    ws,
    hello,
    next: main.next,
    summaries: summaries.next,
    async latest({ card }: { card: string }) {
      for (;;) {
        const messages = await latest.next()

        if (card in messages) {
          return messages[card]
        }
      }
    },
    command({
      id,
      name,
      args,
    }: {
      id: string
      name: string
      args: string[]
    }) {
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name,
        args,
      }))
    },
    async idle() {
      await new Promise(r => setTimeout(
        r,
        150,
      ))
      assert.deepEqual(
        queue,
        [],
      )
    },
  }
}

function http({
  method,
  path,
  headers = {},
}: {
  method: string
  path: string
  headers?: Record<string, string>
}) {
  return new Promise<{
    status: number
    headers: Record<string, unknown>
    text: string
  }>((
    resolve,
    reject,
  ) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server!.port,
        method,
        path,
        headers,
      },
      res => {
        let text = ''
        res.on(
          'data',
          chunk => (text += chunk),
        )
        res.on(
          'end',
          () => resolve({
            status: res.statusCode!,
            headers: res.headers,
            text,
          }),
        )
      },
    )
    req.on(
      'error',
      reject,
    )
    req.end()
  })
}

async function handshakeStatus(
  {
    query,
    headers = {},
    path = '/hydra/default/ws',
  }: {
    query: string
    headers?: Record<string, string>
    path?: string
  },
): Promise<number> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${server!.port}${path}${query}`,
    { headers },
  )
  tabs.add(ws)
  const [
    , response,
  ] = await once(
    ws,
    'unexpected-response',
  )

  return response.statusCode
}

async function hydraWithCard({ hydraId = 'default' }: { hydraId?: string } = {}) {
  mkdirSync(
    hydraDir({ hydraId }),
    { recursive: true },
  )
  appendFileSync(
    join(
      hydraDir({ hydraId }),
      'events.jsonl',
    ),
    '',
  )
  server = await startServer({ hydraId })
  await sendToSocket({
    path: server.socket!,
    text: JSON.stringify(hookEvent({
      id: 'hook-1',
      key: 'a',
      title: 'A',
    })),
  })
  await seqIs({
    seq: 1,
    hydraId,
  })

  return loadHydra({ hydraId }).state.keys.a!
}

test(
  'serve runs until stop, and the summary reports it without starting it',
  async () => {
    const before = cli({ args: [] })
    assert.match(
      before,
      /^server: not running$/m,
    )
    assert.match(
      before,
      /pnyx-axi serve/,
    )
    assert.equal(
      existsSync(infoPath({ hydraId: 'default' })),
      false,
    )

    const child = spawn(
      process.execPath,
      [
        BIN,
        'serve',
        '--port',
        '0',
      ],
      {
        env: process.env,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )
    track({ child })
    let out = ''
    child.stdout.on(
      'data',
      chunk => (out += chunk),
    )
    const url = await until({
      check: () => /^url: "(http:\/\/127\.0\.0\.1:\d+\/hydra\/default\/)"$/m.exec(out)?.[1],
      what: 'serve to start',
    })
    await until({
      check: () => (existsSync(infoPath({ hydraId: 'default' })) ? true : undefined),
      what: 'server.json',
    })
    assert.match(
      cli({ args: [] }),
      new RegExp(
        `^server: "running at ${url}"$`,
        'm',
      ),
    )
    assert.ok(existsSync(socketPath({ hydraId: 'default' })))

    assert.match(
      cli({ args: ['stop'] }),
      /^server: stopped$/m,
    )
    const [code] = await once(
      child,
      'exit',
    )
    assert.equal(
      code,
      0,
    )
    assert.match(
      out,
      /^server: stopped$/m,
    )
    assert.equal(
      existsSync(infoPath({ hydraId: 'default' })),
      false,
    )
    assert.equal(
      existsSync(socketPath({ hydraId: 'default' })),
      false,
    )
    assert.match(
      cli({ args: [] }),
      /^server: not running$/m,
    )
    assert.match(
      cli({ args: ['stop'] }),
      /^server: "none: not running"$/m,
    )
  },
)

test(
  'serve refuses a taken port instead of picking another',
  async () => {
    const holder = createServer().listen(
      0,
      '127.0.0.1',
    )
    await once(
      holder,
      'listening',
    )
    const { port } = holder.address() as { port: number }

    try {
      const child = spawn(
        process.execPath,
        [
          BIN,
          'serve',
          '--port',
          String(port),
        ],
        {
          env: process.env,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],
        },
      )
      track({ child })
      let out = ''
      child.stdout.on(
        'data',
        chunk => (out += chunk),
      )
      const [code] = await once(
        child,
        'exit',
      )
      assert.notEqual(
        code,
        0,
      )
      assert.match(
        out,
        new RegExp(`port ${port} is in use`),
      )
      assert.match(
        out,
        /PORT_IN_USE/,
      )
      assert.match(
        out,
        /--port/,
      )
    } finally {
      holder.close()
    }
  },
)

test(
  'serve takes its port from PORT when --port is not given',
  async () => {
    const holder = createServer().listen(
      0,
      '127.0.0.1',
    )
    await once(
      holder,
      'listening',
    )
    const { port } = holder.address() as { port: number }

    try {
      for (const [
        value,
        expected,
      ] of [
          [
            String(port),
            new RegExp(`port ${port} is in use`),
          ],
          [
            'abc',
            /PORT must be a number/,
          ],
        ] as const) {
        const child = spawn(
          process.execPath,
          [
            BIN,
            'serve',
          ],
          {
            env: {
              ...process.env,
              PORT: value,
            },
            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          },
        )
        track({ child })
        let out = ''
        child.stdout.on(
          'data',
          chunk => (out += chunk),
        )
        const [code] = await once(
          child,
          'exit',
        )
        assert.notEqual(
          code,
          0,
        )
        assert.match(
          out,
          expected,
        )
      }
    } finally {
      holder.close()
    }
  },
)

test(
  'a second server for the same Hydra is refused',
  async () => {
    server = await startServer({ hydraId: 'default' })
    await assert.rejects(
      startServer({ hydraId: 'default' }),
      error => error instanceof HydraError && error.code === 'ALREADY_RUNNING',
    )
  },
)

test(
  'hook events on the socket become cards and reach open tabs',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const t = await tab()
    assert.deepEqual(
      await t.next(),
      {
        type: 'snapshot',
        seq: 0,
        state: loadHydra({ hydraId: 'default' }).state,
      },
    )

    const event = JSON.stringify(hookEvent({
      id: 'hook-1',
      key: 'session-a',
      title: 'Fix the parser',
    }))
    await sendToSocket({
      path: server.socket!,
      text: `${event}\nnot json\n${event}`,
    })
    const message = await t.next()
    assert.equal(
      message.type,
      'event',
    )
    assert.equal(
      message.type === 'event' && message.event.seq,
      1,
    )
    assert.equal(
      message.type === 'event' && message.event.id,
      'hook-1',
    )
    await t.idle()
    const { state } = loadHydra({ hydraId: 'default' })
    assert.equal(
      state.cards[state.keys['session-a']!]!.title,
      'Fix the parser',
    )
    assert.deepEqual(
      readdirSync(spoolDir({ dir: hydraDir({ hydraId: 'default' }) })),
      [],
    )
  },
)

test(
  'spooled hook events are drained on start and while running',
  async () => {
    spoolWrite({
      hydraId: 'default',
      entry: hookEvent({
        id: 'hook-1',
        key: 'session-a',
        title: 'Written while the server was down',
      }),
    })
    server = await startServer({ hydraId: 'default' })
    await seqIs({ seq: 1 })
    spoolWrite({
      hydraId: 'default',
      entry: hookEvent({
        id: 'hook-2',
        key: 'session-b',
        title: 'Spooled while it runs',
      }),
    })
    await seqIs({ seq: 2 })
    const { state } = loadHydra({ hydraId: 'default' })
    assert.deepEqual(
      Object.keys(state.keys).sort(),
      [
        'session-a',
        'session-b',
      ],
    )
    assert.deepEqual(
      readdirSync(spoolDir({ dir: hydraDir({ hydraId: 'default' }) })),
      [],
    )
  },
)

test(
  'a tab resumes from its cursor, gets CLI writes, and resyncs with a snapshot on a gap',
  async () => {
    server = await startServer({ hydraId: 'default' })
    await sendToSocket({
      path: server.socket!,
      text: `${JSON.stringify(hookEvent({
        id: 'hook-1',
        key: 'a',
        title: 'A',
      }))}\n${JSON.stringify(hookEvent({
        id: 'hook-2',
        key: 'b',
        title: 'B',
      }))}\n`,
    })
    await seqIs({ seq: 2 })

    const behind = await tab({ query: '?after=1' })
    const caughtUp = await behind.next()
    assert.equal(
      caughtUp.type === 'event' && caughtUp.event.seq,
      2,
    )
    await behind.idle()

    const current = await tab({ query: '?after=2' })
    await current.idle()

    const ahead = await tab({ query: '?after=99' })
    const snapshot = await ahead.next()
    assert.equal(
      snapshot.type,
      'snapshot',
    )
    assert.equal(
      snapshot.type === 'snapshot' && snapshot.seq,
      2,
    )

    current.ws.send(JSON.stringify({ type: 'resync' }))
    const resynced = await current.next()
    assert.equal(
      resynced.type === 'snapshot' && resynced.seq,
      2,
    )

    const cardId = loadHydra({ hydraId: 'default' }).state.keys.a!
    cli({
      args: [
        'move',
        cardId,
        'done',
      ],
    })
    const moved = await current.next()
    assert.equal(
      moved.type === 'event' && moved.event.seq,
      3,
    )
    assert.equal(
      moved.type === 'event' && moved.event.type,
      'card.moved',
    )
  },
)

test(
  "a tab gets its write's event before the receipt with its request id, recorded as web",
  async () => {
    const cardId = await hydraWithCard()
    const t = await tab({ query: '?after=1' })

    t.command({
      id: 'req-1',
      name: 'move',
      args: [
        cardId,
        'done',
      ],
    })
    const pushed = await t.next()
    assert.equal(
      pushed.type === 'event' && pushed.event.type,
      'card.moved',
    )
    assert.equal(
      pushed.type === 'event' && pushed.event.actor,
      'web',
    )
    const receipt = await t.next()
    assert.equal(
      receipt.type,
      'receipt',
    )
    assert.equal(
      receipt.type === 'receipt' && receipt.id,
      'req-1',
    )
    assert.deepEqual(
      receipt.type === 'receipt' && receipt.card,
      {
        id: cardId,
        column: 'done',
        revision: 2,
      },
    )

    t.command({
      id: 'req-2',
      name: 'outcome',
      args: [
        cardId,
        'done',
        '--actor',
        'leo',
      ],
    })
    const outcome = await t.next()
    assert.equal(
      outcome.type === 'event' && outcome.event.actor,
      'leo',
    )
    assert.equal(
      (await t.next()).type,
      'receipt',
    )
  },
)

test(
  'a bad command gets an error carrying its request id and writes nothing',
  async () => {
    const cardId = await hydraWithCard()
    const t = await tab({ query: '?after=1' })

    const cases: [string, string, unknown, string][] = [
      [
        'r1',
        'push',
        [
          '--key',
          'x',
          '--file',
          '/etc/hosts',
        ],
        'NOT_FOUND',
      ],
      [
        'r2',
        'move',
        'not a list',
        'VALIDATION_ERROR',
      ],
      [
        'r3',
        'move',
        [
          'no-such-card',
          'done',
        ],
        'NOT_FOUND',
      ],
      [
        'r4',
        'move',
        [
          cardId,
          'done',
          '--hydra',
          'other',
        ],
        'VALIDATION_ERROR',
      ],
      [
        'r5',
        'move',
        [
          cardId,
          'done',
          '--hydra=other',
        ],
        'VALIDATION_ERROR',
      ],
      [
        'r6',
        'catalog',
        [
          cardId,
          '/arbitrary/path',
        ],
        'VALIDATION_ERROR',
      ],
      [
        'r7',
        'catalog',
        ['no-such-card'],
        'NOT_FOUND',
      ],
    ]

    for (const [
      id,
      name,
      args,
      code,
    ] of cases) {
      t.ws.send(JSON.stringify({
        type: 'command',
        id,
        name,
        args,
      }))
      const reply = await t.next()
      assert.equal(
        reply.type,
        'error',
      )
      assert.equal(
        reply.type === 'error' && reply.id,
        id,
      )
      assert.equal(
        reply.type === 'error' && reply.code,
        code,
        `${id}: ${reply.type === 'error' && reply.error}`,
      )
    }

    await t.idle()
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      1,
    )
    assert.equal(
      existsSync(hydraDir({ hydraId: 'other' })),
      false,
    )
  },
)

test(
  "writes through the server always land on the server's own Hydra",
  async () => {
    const cardId = await hydraWithCard({ hydraId: 'work' })
    const t = await tab({
      query: '?after=1',
      hydraId: 'work',
    })
    t.command({
      id: 'req-1',
      name: 'move',
      args: [
        cardId,
        'done',
      ],
    })
    assert.equal(
      (await t.next()).type,
      'event',
    )
    assert.equal(
      (await t.next()).type,
      'receipt',
    )
    await seqIs({
      seq: 2,
      hydraId: 'work',
    })
    assert.equal(
      loadHydra({ hydraId: 'work' }).state.cards[cardId]!.column,
      'done',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      0,
    )
  },
)

test(
  'a request needs an exact loopback host and origin or a *.localhost name',
  () => {
    const hosts = new Set(['127.0.0.1:4747'])
    const origins = new Set(['http://127.0.0.1:4747'])
    const check = ({
      host,
      origin,
    }: {
      host?: string
      origin?: string
    }) => allowedRequest({
      host,
      origin,
      hosts,
      origins,
    })

    for (const request of [
      { host: '127.0.0.1:4747' },
      {
        host: '127.0.0.1:4747',
        origin: 'http://127.0.0.1:4747',
      },
      { host: 'pnyx.localhost' },
      {
        host: 'cards.pnyx.localhost:1355',
        origin: 'https://cards.pnyx.localhost',
      },
      {
        host: 'pnyx.localhost',
        origin: 'http://pnyx.localhost:1355',
      },
    ]) {
      assert.ok(
        check(request),
        JSON.stringify(request),
      )
    }

    for (const request of [
      {},
      { host: '127.0.0.1:4748' },
      { host: 'evil.example' },
      { host: 'pnyx.localhost.evil.com' },
      { host: 'localhost.evil.com' },
      { host: 'evil.com:4747.localhost' },
      {
        host: '127.0.0.1:4747',
        origin: 'http://evil.example',
      },
      {
        host: 'pnyx.localhost',
        origin: 'https://pnyx.localhost.evil.com',
      },
      {
        host: 'pnyx.localhost',
        origin: 'https://localhost.evil.com',
      },
      {
        host: 'pnyx.localhost',
        origin: 'ftp://pnyx.localhost',
      },
      {
        host: 'pnyx.localhost',
        origin: 'null',
      },
    ]) {
      assert.ok(
        !check(request),
        JSON.stringify(request),
      )
    }
  },
)

test(
  'the WebSocket handshake needs the token, an exact host and an exact origin',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const token = `?token=${localToken()}`
    assert.equal(
      await handshakeStatus({ query: '' }),
      401,
    )
    assert.equal(
      await handshakeStatus({ query: '?token=wrong' }),
      401,
    )
    assert.equal(
      await handshakeStatus({
        query: token,
        headers: { origin: 'http://evil.example' },
      }),
      403,
    )
    assert.equal(
      await handshakeStatus({
        query: token,
        headers: { origin: `http://127.0.0.1:${server.port}.evil.example` },
      }),
      403,
    )
    assert.equal(
      await handshakeStatus({
        query: token,
        headers: { host: `evil.example:${server.port}` },
      }),
      403,
    )
    assert.equal(
      await handshakeStatus({
        query: token,
        path: '/hydra/missing/ws',
      }),
      403,
    )

    // /ws stays the default Hydra's, so a tab from before one server served every Hydra reconnects and reloads.
    for (const path of [
      '/hydra/default/ws',
      '/ws',
    ]) {
      const ok = new WebSocket(
        `ws://127.0.0.1:${server.port}${path}${token}`,
        { headers: { origin: `http://localhost:${server.port}` } },
      )
      tabs.add(ok)
      await once(
        ok,
        'open',
      )
      ok.close()
    }
  },
)

test(
  'the Hydra page carries the token only for its own host and origin; /health names the Hydra',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const meta = `<meta name="pnyx-token" content="${localToken()}" />`

    for (const path of [
      '/hydra/default/',
      '/hydra/default/index.html',
      '/hydra/default/some/route',
    ]) {
      const page = await http({
        method: 'GET',
        path,
        headers: { origin: `http://127.0.0.1:${server.port}` },
      })
      assert.equal(
        page.status,
        200,
      )
      assert.ok(
        page.text.includes(meta),
        path,
      )
      assert.ok(
        page.text.includes('<base href="/hydra/default/" />'),
        path,
      )
      assert.equal(
        page.headers['cache-control'],
        'no-store',
      )
    }

    for (const headers of [
      { host: `evil.example:${server.port}` },
      { origin: 'http://evil.example' },
    ] as Record<string, string>[]) {
      const refused = await http({
        method: 'GET',
        path: '/hydra/default/',
        headers,
      })
      assert.equal(
        refused.status,
        403,
      )
      assert.ok(!refused.text.includes(localToken()))
    }

    const root = await http({
      method: 'GET',
      path: '/',
    })
    assert.equal(
      root.status,
      302,
    )
    assert.equal(
      root.headers.location,
      '/hydra/default/',
    )
    assert.equal(
      (await http({
        method: 'GET',
        path: '/hydra/default',
      })).headers.location,
      '/hydra/default/',
    )
    // Outside a Hydra only the shared assets are served, never a page carrying the token.
    assert.equal(
      (await http({
        method: 'GET',
        path: '/index.html',
      })).status,
      404,
    )
    assert.equal(
      (await http({
        method: 'GET',
        path: '/favicon.svg',
      })).status,
      200,
    )
    assert.equal(
      (await http({
        method: 'GET',
        path: '/hydra/missing/',
      })).status,
      404,
    )

    const health = await http({
      method: 'GET',
      path: '/hydra/default/health',
    })
    assert.equal(
      health.status,
      200,
    )
    const { build } = JSON.parse(health.text) as { build: string }
    assert.deepEqual(
      JSON.parse(health.text),
      {
        hydraId: 'default',
        pid: process.pid,
        build,
      },
    )
    assert.match(
      build,
      /^[0-9a-f]{12}$/,
    )
    assert.deepEqual(
      JSON.parse((await http({
        method: 'GET',
        path: '/health',
      })).text),
      {
        pid: process.pid,
        build,
        hydras: ['default'],
        skipped: {},
      },
    )
    const html = (await http({
      method: 'GET',
      path: '/hydra/default/',
    })).text
    assert.ok(html.includes(`<meta name="pnyx-build" content="${build}" />`))
    const identity = /name="pnyx-hydra" content="([a-f0-9]{24})"/.exec(html)?.[1]
    assert.ok(identity)
    assert.deepEqual(
      (await tab()).hello,
      {
        type: 'hello',
        build,
        hydraId: identity,
      },
    )
    assert.equal(
      (await http({
        method: 'GET',
        path: '/hydra/default/api/commands/move',
      })).status,
      200,
    )
    assert.equal(
      (await http({
        method: 'POST',
        path: '/hydra/default/api/commands/move',
      })).status,
      405,
    )
  },
)

test(
  'a server.json left by a dead server is not trusted, even when its pid was reused',
  async () => {
  // A live process that is not a Pnyx server, and a port nothing listens on.
  // It must outlast the CLI calls below on a loaded machine; the test's cleanup stops it.
    const other = spawn(
      process.execPath,
      [
        '-e',
        'setTimeout(() => {}, 600000)',
      ],
      { stdio: 'ignore' },
    )
    track({ child: other })
    const probe = createServer().listen(
      0,
      '127.0.0.1',
    )
    await once(
      probe,
      'listening',
    )
    const port = (probe.address() as { port: number }).port
    await new Promise(r => probe.close(r))

    mkdirSync(
      hydraDir({ hydraId: 'default' }),
      { recursive: true },
    )
    writeFileSync(
      infoPath({ hydraId: 'default' }),
      JSON.stringify({
        pid: other.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        socket: null,
      }),
    )

    assert.match(
      cli({ args: [] }),
      /^server: not running$/m,
    )
    assert.match(
      cli({ args: ['stop'] }),
      /^server: "none: not running"$/m,
    )
    assert.equal(
      other.exitCode,
      null,
    )
    assert.equal(
      other.signalCode,
      null,
    )
    server = await startServer({ hydraId: 'default' })
  },
)

test(
  'oversized WebSocket frames close only their connection and keep the server running',
  async () => {
    await hydraWithCard()
    const t = await tab(); await t.next()
    const envelope = JSON.stringify({
      type: 'ping',
      padding: '',
    })
    const padding = 'x'.repeat(MAX_MESSAGE_BYTES - Buffer.byteLength(envelope))
    const atLimit = JSON.stringify({
      type: 'ping',
      padding,
    })
    assert.equal(
      Buffer.byteLength(atLimit),
      MAX_MESSAGE_BYTES,
    )
    t.ws.send(atLimit)
    assert.equal(
      (await t.next()).type,
      'pong',
    )
    const closed = once(
      t.ws,
      'close',
    )
    t.ws.send(JSON.stringify({
      type: 'ping',
      padding: padding + 'x',
    }))
    assert.equal(
      (await closed)[0],
      1009,
    )
    const other = await tab(); await other.next()
    other.ws.send(JSON.stringify({ type: 'ping' }))
    assert.equal(
      (await other.next()).type,
      'pong',
    )
  },
)

test(
  'web preferences, custom moves and read queries share the authenticated socket',
  async () => {
    const card = await hydraWithCard()
    const t = await tab(); await t.next()
    t.command({
      id: 'view-1',
      name: 'view',
      args: [
        'set',
        '--json',
        JSON.stringify({
          customColumns: [
            {
              id: 'custom:later',
              title: 'Later',
            },
          ],
          panelWidth: 500,
        }),
        '--if-revision',
        '0',
        '--event-id',
        'web-view',
      ],
    })
    const update = await t.next(); assert.equal(
      update.type,
      'event',
    )
    const receipt = await t.next(); assert.equal(
      receipt.type,
      'receipt',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.view?.panelWidth,
      500,
    )
    t.command({
      id: 'move-1',
      name: 'move',
      args: [
        card,
        'custom:later',
        '--if-revision',
        '1',
      ],
    })
    assert.equal(
      (await t.next()).type,
      'event',
    ); assert.equal(
      (await t.next()).type,
      'receipt',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card]?.column,
      'custom:later',
    )
    t.command({
      id: 'view-stale',
      name: 'view',
      args: [
        'set',
        '--json',
        '{"fontSize":18}',
        '--if-revision',
        '0',
      ],
    })
    const stale = await t.next(); assert.equal(
      stale.type,
      'error',
    )

    if (stale.type === 'error') {
      assert.equal(
        stale.code,
        'REVISION_CONFLICT',
      )
    }

    t.command({
      id: 'thread-1',
      name: 'thread',
      args: [card],
    })
    const thread = await t.next(); assert.equal(
      thread.type,
      'receipt',
    )

    if (thread.type === 'receipt') {
      assert.equal(
        (thread.thread as { route: boolean }).route,
        false,
      )
    }

    t.command({
      id: 'view-2',
      name: 'view',
      args: [
        'set',
        '--json',
        '{"panelWidth":520}',
        '--if-revision',
        '1',
      ],
    })
    assert.deepEqual(
      [
        (await t.next()).type,
        (await t.next()).type,
      ],
      [
        'event',
        'receipt',
      ],
      'a resize leaves the open conversation alone',
    )
    t.command({
      id: 'view-3',
      name: 'view',
      args: [
        'set',
        '--json',
        JSON.stringify({ focusMode: false }),
        '--if-revision',
        '2',
      ],
    })
    assert.deepEqual(
      [
        (await t.next()).type,
        (await t.next()).type,
        (await t.next()).type,
      ].sort(),
      [
        'event',
        'receipt',
        'thread',
      ],
      'showing traces pages the conversation again',
    )

    t.command({
      id: 'reply-1',
      name: 'reply',
      args: [
        card,
        'test',
        'id',
      ],
    })
    const reply = await t.next(); assert.equal(
      reply.type,
      'error',
    )

    if (reply.type === 'error') {
      assert.equal(
        reply.code,
        'NO_ROUTE',
      )
    }

    t.command({
      id: 'agent-1',
      name: 'agent',
      args: [
        card,
        'effort',
        'high',
        'id',
      ],
    })
    const agent = await t.next(); assert.equal(
      agent.type,
      'error',
    )

    if (agent.type === 'error') {
      assert.equal(
        agent.code,
        'NO_ROUTE',
      )
    }

    t.command({
      id: 'agent-2',
      name: 'agent',
      args: [
        card,
        'effort',
        'high',
      ],
    })
    const short = await t.next(); assert.equal(
      short.type,
      'error',
    )

    if (short.type === 'error') {
      assert.equal(
        short.code,
        'VALIDATION_ERROR',
      )
    }

    t.command({
      id: 'history-1',
      name: 'history',
      args: [
        '--card',
        card,
      ],
    }); assert.equal(
      (await t.next()).type,
      'receipt',
    )
    t.command({
      id: 'escape-Hydra',
      name: 'history',
      args: [
        '--hydra',
        'other',
      ],
    }); assert.equal(
      (await t.next()).type,
      'error',
    )
    t.command({
      id: 'card-1',
      name: 'card',
      args: [
        card,
        '--full',
      ],
    })
    const shown = await t.next(); assert.equal(
      shown.type,
      'receipt',
    )

    if (shown.type === 'receipt') {
      assert.deepEqual(
        shown.notes,
        {
          summary: 'none',
          decisions: 'none',
          context: 'none',
        },
      )
    }

    t.ws.close()
  },
)

test(
  "overlapping catalog requests share or queue the socket's read and answer each with its own card",
  async () => {
    const home = process.env.PNYX_HOME!, locations = {
      home,
      claude: join(
        home,
        'claude',
      ),
      codex: join(
        home,
        'codex',
      ),
    }

    for (const key of [
      'one',
      'two',
    ]) {
      const cwd = join(
        home,
        key,
      ); mkdirSync(
        join(
          cwd,
          '.git',
        ),
        { recursive: true },
      ); mkdirSync(
        join(
          cwd,
          '.claude/skills',
          `skill-${key}`,
        ),
        { recursive: true },
      )
      writeFileSync(
        join(
          cwd,
          '.claude/skills',
          `skill-${key}`,
          'SKILL.md',
        ),
        `---\nname: skill-${key}\ndescription: ${key}\n---\n`,
      )
      withWriter({
        hydraId: 'default',
        fn: ({ writer: w }) => {
          const d = decidePush({
            state: w.state,
            newCardId: `c${w.state.seq + 1}`,
            key,
            input: {
              title: key,
              agent: {
                provider: 'claude',
                sessionId: key,
                cwd,
              },
            },
            meta: {
              actor: 'test',
              at: '2026-10-14T10:00:00Z',
            },
          }); assert.ok('event' in d); w.append({ event: d.event })
        },
      })
    }

    const {
      one,
      two,
    } = loadHydra({ hydraId: 'default' }).state.keys
    server = await startServer({
      hydraId: 'default',
      catalogLocations: locations,
    })
    const t = await tab(); await t.next()
    const requests = [
      [
        'c1',
        one,
      ],
      [
        'c2',
        one,
      ],
      [
        'c3',
        two,
      ],
      [
        'c4',
        one,
      ],
    ] as const

    for (const [
      id,
      card,
    ] of requests) {
      t.command({
        id,
        name: 'catalog',
        args: [card!],
      })
    }

    const replies = new Map<string, ServerMessage>()

    for (let n = 0; n < requests.length; n++) {
      const reply = await t.next(); replies.set(
        (reply as { id: string }).id,
        reply,
      )
    }

    for (const [
      id,
      card,
    ] of requests) {
      const reply = replies.get(id)!; assert.equal(
        reply.type,
        'receipt',
        `${id}: ${JSON.stringify(reply)}`,
      )
      const commands = (
        reply as unknown as { catalog: { suggestions: { command: string }[] } }
      ).catalog.suggestions.map(s => s.command)
      assert.deepEqual(
        commands,
        [card === one ? '/skill-one' : '/skill-two'],
      )
    }

    t.ws.close()
  },
)

test(
  'browser reply delivery uses only configured fixture homes and never resends an unknown result',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    server = await startServer({
      hydraId: 'default',
      homes: [fixture.nativeHome],
    })
    const t = await tab(); await t.next()
    const card = fixture.state.keys.layout!
    writeFileSync(
      join(
        fixture.nativeHome,
        'send-exit',
      ),
      '3',
    )

    const receipt = async ({ id }: { id: string }) => {
      for (;;) {
        const m = await t.next({ ms: CLI_TIMEOUT_MS })

        if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
          return m
        }
      }
    }

    t.command({
      id: 'send-1',
      name: 'reply',
      args: [
        card,
        'A literal fixture reply',
        'unknown-reply',
      ],
    })
    const first = await receipt({ id: 'send-1' }); assert.equal(
      first.type,
      'receipt',
    )

    if (first.type === 'receipt') {
      assert.equal(
        (first.reply as { state: string }).state,
        'delivery_unknown',
      )
    }

    t.command({
      id: 'send-2',
      name: 'reply',
      args: [
        card,
        'A literal fixture reply',
        'unknown-reply',
      ],
    })
    const second = await receipt({ id: 'send-2' }); assert.equal(
      second.type,
      'receipt',
    )

    if (second.type === 'receipt') {
      assert.equal(
        (second.reply as { sent: boolean }).sent,
        false,
      )
    }

    assert.equal(
      readFileSync(
        join(
          fixture.nativeHome,
          'sent.log',
        ),
        'utf8',
      ).match(/A literal fixture reply/g)?.length,
      1,
    )
    t.command({
      id: 'send-3',
      name: 'reply',
      args: [
        card,
        '   ',
        'blank-reply',
      ],
    })
    const invalid = await receipt({ id: 'send-3' }); assert.equal(
      invalid.type,
      'error',
    )

    if (invalid.type === 'error') {
      assert.equal(
        invalid.code,
        'VALIDATION_ERROR',
      )
    }

    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card]?.attention.length,
      1,
    )

    const sends = readFileSync(
      join(
        fixture.nativeHome,
        'sent.log',
      ),
      'utf8',
    )
    t.command({
      id: 'agent-1',
      name: 'agent',
      args: [
        card,
        'effort',
        'high',
        'effort-1',
      ],
    })
    const changed = await receipt({ id: 'agent-1' }); assert.equal(
      changed.type,
      'receipt',
      JSON.stringify(changed),
    )

    if (changed.type === 'receipt') {
      assert.equal(
        (changed.agent as { sent: string }).sent,
        'delivered',
      )
    }

    assert.match(
      readFileSync(
        join(
          fixture.nativeHome,
          'inbox.log',
        ),
        'utf8',
      ),
      /arg=pnyx:default:c\d+:effort-1\narg=--json\narg=--\narg=Pnyx: please switch the worker on task api-v2 \(Claude Code\) to effort high\.\n---\n$/,
    )
    assert.equal(
      readFileSync(
        join(
          fixture.nativeHome,
          'sent.log',
        ),
        'utf8',
      ),
      sends,
    )
    // An inline answer goes through the same worker; its values, even one starting with
    // a dash, reach the CLI as values, which refuses a request it cannot answer here.
    t.command({
      id: 'answer-1',
      name: 'answer',
      args: [
        card,
        '-hook:tool:Bash',
        '{"choice":"allow"}',
        'answer-1',
        '-seen',
      ],
    })
    const refused = await receipt({ id: 'answer-1' }); assert.equal(
      refused.type,
      'error',
      JSON.stringify(refused),
    )

    if (refused.type === 'error') {
      assert.match(
        JSON.stringify(refused),
        /no open request with key -hook:tool:Bash/,
      )
    }

    t.command({
      id: 'answer-2',
      name: 'answer',
      args: [
        card,
        'hook:tool:Bash',
        '{}',
      ],
    })
    const short = await receipt({ id: 'answer-2' }); assert.equal(
      short.type,
      'error',
    )

    if (short.type === 'error') {
      assert.equal(
        short.code,
        'VALIDATION_ERROR',
      )
    }

    t.command({
      id: 'oracle-1',
      name: 'oracle',
      args: ['conversation readable'],
    })
    const found = await receipt({ id: 'oracle-1' }); assert.equal(
      found.type,
      'receipt',
    )

    if (found.type === 'receipt') {
      assert.equal(
        (found.hits as { card: string }[])[0]?.card,
        card,
      )
    }

    t.ws.close()
  },
)

const assistantLine = ({
  text,
  at,
}: {
  text: string
  at: string
}) => JSON.stringify({
  type: 'assistant',
  timestamp: at,
  message: {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  },
}) + '\n'

test(
  'the Hydra search finds a card by a word only its transcript holds, including words a live session just wrote',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()

    const search = async ({
      id,
      text,
    }: {
      id: string
      text: string
    }) => {
      t.command({
        id,
        name: 'oracle',
        args: [text],
      })

      for (;;) {
        const m = await t.next()

        if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
          return m
        }
      }
    }

    const cards = ({ m }: { m: ServerMessage }) => (m.type === 'receipt' ? (m.hits as { card: string }[]).map(h => h.card) : m)
    // "readable" is only in the transcript's first user message, not in any title, link or event.
    assert.deepEqual(
      cards({
        m: await search({
          id: 's1',
          text: 'readable',
        }),
      }),
      [fixture.state.keys.layout],
    )
    appendFileSync(
      fixture.transcript,
      assistantLine({
        text: 'The flamingo rollout is staged behind the flag.',
        at: '2026-10-13T11:00:00Z',
      }),
    )
    const byText = await search({
      id: 's2',
      text: 'flamingo rollout',
    })
    assert.deepEqual(
      cards({ m: byText }),
      [fixture.state.keys.layout],
    )
    assert.equal(
      byText.type === 'receipt' && (byText.hits as { match: string }[])[0]!.match,
      'lexical',
    )
    assert.deepEqual(
      cards({
        m: await search({
          id: 's3',
          text: 'flamingo nowhere',
        }),
      }),
      [],
    )
    t.ws.close()
  },
)

test(
  'a Hydra search rebuilds a stale search index',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    writeFileSync(
      searchPath({ hydraId: 'default' }),
      'not a database',
    )
    assert.equal(
      indexStatus({ hydraId: 'default' })?.current,
      false,
    )
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()
    t.command({
      id: 's1',
      name: 'oracle',
      args: ['readable'],
    })
    let m = await t.next()

    while (!((m.type === 'receipt' || m.type === 'error') && m.id === 's1')) {
      m = await t.next()
    }

    assert.deepEqual(
      m.type === 'receipt' && (m.hits as { card: string }[]).map(h => h.card),
      [fixture.state.keys.layout],
    )
    const status = indexStatus({ hydraId: 'default' })
    assert.equal(
      status?.current,
      true,
    )
    assert.equal(
      status?.transcripts.tracked,
      1,
    )
    t.ws.close()
  },
)

test(
  "each card gets its conversation's last message, pushed again as the transcript grows",
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()
    assert.deepEqual(
      await t.latest({ card }),
      {
        role: 'assistant',
        text: 'The first pass is ready to review. Try resizing a column or switching the conversation to inline in Settings.',
        at: '2026-10-13T10:49:00Z',
      },
    )
    appendFileSync(
      fixture.transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-13T11:00:00Z',
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'hidden',
            },
            {
              type: 'tool_use',
              name: 'Bash',
              input: {},
            },
          ],
        },
      }) + '\n',
    )
    appendFileSync(
      fixture.transcript,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-13T11:01:00Z',
        message: { content: 'Ship   it\nnow.' },
      }) + '\n',
    )
    appendFileSync(
      fixture.transcript,
      assistantLine({
        text: 'Shipped.',
        at: '2026-10-13T11:02:00Z',
      }),
    )
    assert.deepEqual(
      await t.latest({ card }),
      {
        role: 'assistant',
        text: 'Shipped.',
        at: '2026-10-13T11:02:00Z',
      },
    )
    const later = await tab(); await later.next()
    assert.deepEqual(
      await later.latest({ card }),
      {
        role: 'assistant',
        text: 'Shipped.',
        at: '2026-10-13T11:02:00Z',
      },
    )
    t.ws.send(JSON.stringify({ type: 'resync' }))
    assert.equal(
      (await t.next()).type,
      'snapshot',
    )
    assert.deepEqual(
      await t.latest({ card }),
      {
        role: 'assistant',
        text: 'Shipped.',
        at: '2026-10-13T11:02:00Z',
      },
    )
    t.ws.close(); later.ws.close()
  },
)

test(
  "a tab whose snapshot alone fills its send buffer still gets every card's last message",
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    server = await startServer({ hydraId: 'default' })
    const card = fixture.state.keys.layout!, message = {
      role: 'assistant',
      text: 'The first pass is ready to review. Try resizing a column or switching the conversation to inline in Settings.',
      at: '2026-10-13T10:49:00Z',
    }
    const first = await tab(); await first.next()
    assert.deepEqual(
      await first.latest({ card }),
      message,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer: w }) => {
        const d = decidePush({
          state: w.state,
          newCardId: `c${w.state.seq + 1}`,
          key: 'big',
          input: { title: 'x'.repeat(4 << 20) },
          meta: {
            actor: 'test',
            at: '2026-10-14T10:00:00Z',
          },
        }); assert.ok('event' in d); w.append({ event: d.event })
      },
    })
    assert.equal(
      (await first.next()).type,
      'event',
    )
    // The card's message is read already, so a later tab gets it only right after its snapshot.
    const t = await tab()
    assert.equal(
      (await t.next()).type,
      'snapshot',
    )
    assert.deepEqual(
      await t.latest({ card }),
      message,
    )
    first.ws.close(); t.ws.close()
  },
)

test(
  'with semantic search on, the Hydra search finds a transcript-only card by meaning when its words do not all match',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    appendFileSync(
      fixture.transcript,
      assistantLine({
        text: 'Flamingo rollout staged.',
        at: '2026-10-13T11:00:00Z',
      }),
    )
    // The stub worker embeds with hashed word vectors, so no model is fetched or loaded.
    delete process.env.PNYX_SEMANTIC
    process.env.PNYX_SEMANTIC_STUB = '1'
    writeSetting({
      key: 'oracle.rerank',
      value: 'off',
    })

    try {
      server = await startServer({ hydraId: 'default' })
      const t = await tab(); await t.next()
      // "dinosaur" is nowhere, so full text finds nothing; the transcript holds the other words.
      // The first search waits for the worker to start and embed the Hydra, so receipts may be slow:
      // wait longer than the server's own worst case (10s index request plus 30s embed request).
      const deadline = Date.now() + 60_000

      const receipt = async ({ id }: { id: string }): Promise<ServerMessage> => {
        for (;;) {
          try {
            const m = await t.next()

            if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
              return m
            }
          } catch (error) {
            if (Date.now() > deadline) {
              throw error
            }
          }
        }
      }

      let hits: {
        card: string
        match: string
        weak?: true
      }[] = []

      for (let n = 0; !hits.some(h => h.match === 'semantic') && Date.now() < deadline; n++) {
        t.command({
          id: `m${n}`,
          name: 'oracle',
          args: ['flamingo rollout staged dinosaur'],
        })
        const m = await receipt({ id: `m${n}` })
        assert.equal(
          m.type,
          'receipt',
          JSON.stringify(m),
        )
        hits = m.type === 'receipt' ? m.hits as typeof hits : []
      }

      assert.deepEqual(
        hits.filter(h => !h.weak).map(h => [
          h.card,
          h.match,
        ]),
        [
          [
            fixture.state.keys.layout,
            'semantic',
          ],
        ],
      )
      t.ws.close()
    } finally {
      writeSetting({
        key: 'oracle.semantic',
        value: 'off',
      })
      process.env.PNYX_SEMANTIC = 'off'
      delete process.env.PNYX_SEMANTIC_STUB
    }
  },
)

test(
  'a stopped server leaves no open handles, even with Hydra and transcript changes still in flight',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    const settle = () => new Promise(r => setTimeout(
      r,
      300,
    ))
    await settle()
    const before = process.getActiveResourcesInfo().sort()
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()
    assert.ok(await t.latest({ card }))
    t.command({
      id: 'thread-1',
      name: 'thread',
      args: [card],
    })
    t.command({
      id: 'oracle-1',
      name: 'oracle',
      args: ['readable'],
    })

    for (let n = 0; n < 2;) {
      const m = await t.next()

      if (m.type === 'receipt') {
        n++
      }
    }

    // Changes that land just before the stop schedule more work: a log append, a spool
    // drain and a transcript write that the folder watchers see.
    appendFileSync(
      fixture.transcript,
      assistantLine({
        text: 'Still writing.',
        at: '2026-10-13T11:05:00Z',
      }),
    )
    cli({
      args: [
        'move',
        card,
        'done',
      ],
    })
    await server.close()
    server = undefined
    await settle()
    assert.deepEqual(
      process.getActiveResourcesInfo().sort(),
      before,
    )
  },
)

test(
  'the open task follows attachment identity and watches only its current transcript',
  async () => {
    const home = process.env.PNYX_HOME!
    const paths = {
      a: join(
        home,
        'session-a.jsonl',
      ),
      b: join(
        home,
        'session-b.jsonl',
      ),
    }
    const line = ({ text }: { text: string }) => `${JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    })}\n`

    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        for (const key of [
          'task',
          'a',
          'b',
        ] as const) {
          if (key !== 'task') {
            writeFileSync(
              paths[key],
              line({ text: `Conversation ${key}` }),
            )
          }

          const input = key === 'task' ? { title: 'Task conversation' } : {
            agent: {
              provider: 'claude-code',
              sessionId: key,
              transcriptPath: paths[key],
            },
            terminal: {
              tty: '/dev/ttys123',
              pid: '123',
            },
            source: {
              adapter: 'hooks',
              instanceId: 'claude',
              objectId: key,
            },
          }
          const decision = decidePush({
            state: writer.state,
            newCardId: `c${writer.state.seq + 1}`,
            key,
            input,
            meta: {
              at: '2026-10-14T12:00:00Z',
              actor: 'test',
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        }
      },
    })
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()

    const page = async ({
      session,
      text,
    }: {
      session?: string
      text?: string
    }) => {
      for (;;) {
        const message = await t.next()
        const thread = message.type === 'thread' ? message.thread
          : message.type === 'receipt' ? message.thread as import('../src/thread/read.ts').ThreadPage | undefined
            : undefined

        if (thread?.session === session && thread
        && (!text || thread.entries.some(entry => entry.text.includes(text)))) {
          return thread
        }
      }
    }

    try {
      t.command({
        id: 'thread',
        name: 'thread',
        args: ['task'],
      })
      await page({})
      t.command({
        id: 'attach-a',
        name: 'task',
        args: [
          'attach',
          'task',
          '--session',
          'claude-code:a',
        ],
      })
      assert.equal(
        (await page({
          session: 'claude-code:a',
          text: 'Conversation a',
        })).entries.length,
        1,
      )
      appendFileSync(
        paths.a,
        line({ text: 'A continued' }),
      )
      await page({
        session: 'claude-code:a',
        text: 'A continued',
      })
      t.command({
        id: 'detach-a',
        name: 'task',
        args: [
          'detach',
          'task',
        ],
      })
      assert.deepEqual(
        (await page({})).entries,
        [],
      )
      t.command({
        id: 'attach-b',
        name: 'task',
        args: [
          'attach',
          'task',
          '--session',
          'claude-code:b',
        ],
      })
      const switched = await page({
        session: 'claude-code:b',
        text: 'Conversation b',
      })
      assert.equal(
        switched.entries.some(entry => entry.text.includes('Conversation a')),
        false,
      )
      appendFileSync(
        paths.a,
        line({ text: 'A after moving away' }),
      )
      await t.idle()
      appendFileSync(
        paths.b,
        line({ text: 'B continued' }),
      )
      await page({
        session: 'claude-code:b',
        text: 'B continued',
      })
    } finally {
      t.ws.close()
    }
  },
)

test(
  'the Hydra edits heads dispatch rules over the socket',
  async () => {
    await hydraWithCard()
    const t = await tab(); await t.next()
    t.command({
      id: 'rule-1',
      name: 'rule',
      args: [
        'set',
        'review',
        '--harness',
        'codex',
        '--model',
        'gpt-6.1-sol',
        '--when',
        'Independent review',
      ],
    })
    const receipt = await t.next()
    assert.equal(
      receipt.type,
      'receipt',
    )
    t.command({
      id: 'rule-list',
      name: 'rule',
      args: ['list'],
    })
    const result = await t.next()
    assert.equal(
      result.type,
      'receipt',
    )
    const effective = result as unknown as {
      dispatch: {
        rules: Record<string, {
          when: string
          candidates: unknown[]
        }>
      }
    }
    assert.deepEqual(
      effective.dispatch.rules.review,
      {
        when: 'Independent review',
        candidates: [
          {
            harness: 'codex',
            model: 'gpt-6.1-sol',
          },
        ],
      },
    )
    t.command({
      id: 'old-kind',
      name: 'kind',
      args: ['list'],
    })
    assert.equal(
      (await t.next()).type,
      'error',
    )
    t.ws.close()
  },
)

test(
  'Hydras list projects and counts, create, rename and open on the same server',
  async () => {
    cli({
      args: [
        'hydra',
        'create',
        'default',
        '--name',
        'Main',
      ],
    })
    const folder = join(
      process.env.PNYX_HOME!,
      'project',
    )
    mkdirSync(folder)
    cli({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    cli({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--project',
        folder,
      ],
    })
    cli({
      args: [
        'task',
        'create',
        '--key',
        'hidden',
        '--title',
        'Hidden',
        '--project',
        folder,
      ],
    })
    const input = join(
      process.env.PNYX_HOME!,
      'input.json',
    )
    writeFileSync(
      input,
      JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'fake',
        },
        activity: 'working',
        attention: [
          {
            key: 'ask',
            kind: 'question',
            blocking: true,
          },
          {
            key: 'answered',
            kind: 'question',
            blocking: true,
            answered: 'reply-1',
          },
        ],
      }),
    )
    cli({
      args: [
        'push',
        '--key',
        'work',
        '--file',
        input,
      ],
    })
    writeFileSync(
      input,
      readFileSync(
        input,
        'utf8',
      ).replace(
        'fake',
        'fake-hidden',
      ),
    )
    cli({
      args: [
        'push',
        '--key',
        'hidden',
        '--file',
        input,
      ],
    })
    cli({
      args: [
        'task',
        'hide',
        'hidden',
        '--reason',
        'test fixture',
      ],
    })
    server = await startServer({
      hydraId: 'default',
      port: 0,
    })
    const t = await tab()

    const receipt = async ({ id }: { id: string }) => {
      for (;;) {
        const message = await t.next()

        if ((message.type === 'receipt' || message.type === 'error') && message.id === id) {
          type Hydras = {
            hydras?: HydraSummary[]
            url?: string
            error?: string
          }

          return message as ServerMessage & Hydras
        }
      }
    }

    t.command({
      id: 'b1',
      name: 'hydras',
      args: [],
    })
    const listed = (await receipt({ id: 'b1' })).hydras
    assert.deepEqual(
      listed?.map(h => [
        h.id,
        h.name,
      ]),
      [
        [
          'default',
          'Main',
        ],
      ],
    )
    assert.deepEqual(
      listed?.[0]?.projects,
      [
        {
          name: 'project',
          path: realpathSync(folder),
          references: [realpathSync(folder)],
          live: 1,
          asks: 1,
        },
      ],
    )

    t.command({
      id: 'b2',
      name: 'hydras',
      args: [
        'rename',
        'default',
        'Work',
      ],
    })
    assert.deepEqual(
      (await receipt({ id: 'b2' })).hydras?.map(b => b.name),
      ['Work'],
    )

    t.command({
      id: 'b3',
      name: 'hydras',
      args: [
        'create',
        'Side',
      ],
    })
    const created = await receipt({ id: 'b3' })
    assert.deepEqual(
      created.hydras?.map(b => [
        b.id,
        b.name,
      ]),
      [
        [
          'default',
          'Work',
        ],
        [
          'hydra-2',
          'Side',
        ],
      ],
    )
    assert.equal(
      created.url,
      `http://127.0.0.1:${server.port}/hydra/hydra-2/`,
    )
    assert.equal(
      (await readServer({ hydraId: 'hydra-2' }))?.pid,
      process.pid,
    )
    t.command({
      id: 'b4',
      name: 'hydras',
      args: [
        'open',
        'hydra-2',
      ],
    })
    assert.equal(
      (await receipt({ id: 'b4' })).url,
      created.url,
    )
    assert.equal(
      (await (await tab({ hydraId: 'hydra-2' })).next()).type,
      'snapshot',
    )

    t.command({
      id: 'b5',
      name: 'hydras',
      args: [
        'open',
        'missing',
      ],
    })
    assert.match(
      (await receipt({ id: 'b5' })).error ?? '',
      /Hydra not found/,
    )
  },
)

test(
  'project workload changes in another Hydra are pushed to subscribed tabs',
  async () => {
    const folder = join(
      process.env.PNYX_HOME!,
      'project',
    )
    mkdirSync(folder)
    cli({
      args: [
        'hydra',
        'create',
        'other',
        '--name',
        'Other',
      ],
    })
    cli({
      args: [
        'project',
        'add',
        folder,
        '--hydra',
        'other',
      ],
    })
    cli({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Other work',
        '--project',
        folder,
        '--hydra',
        'other',
      ],
    })
    server = await startServer({
      hydraId: 'default',
      port: 0,
    })
    const t = await tab(); await t.next()
    t.command({
      id: 'subscribe-hydras',
      name: 'hydras',
      args: [],
    })
    assert.equal(
      (await t.next()).type,
      'receipt',
    )
    const input = join(
      process.env.PNYX_HOME!,
      'workload.json',
    )
    writeFileSync(
      input,
      JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'other-worker',
        },
        activity: 'working',
        attention: [
          {
            key: 'ask',
            kind: 'question',
            blocking: true,
          },
        ],
      }),
    )
    cli({
      args: [
        'push',
        '--key',
        'work',
        '--file',
        input,
        '--hydra',
        'other',
      ],
    })

    for (;;) {
      const update = await t.summaries()
      const project = update.hydras.find(h => h.id === 'other')?.projects[0]

      if (project?.live === 1 && project.asks === 1) {
        assert.equal(
          update.hydraId,
          'default',
        )
        break
      }
    }

    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      0,
    )
  },
)

test(
  'one server serves every Hydra with its own hook socket, skips one that fails to load and serves one created later',
  async () => {
    cli({
      args: [
        'hydra',
        'create',
        'work',
        '--name',
        'Work',
      ],
    })
    // A folder whose name is not a Hydra id cannot be loaded.
    mkdirSync(join(
      process.env.PNYX_HOME!,
      'hydras',
      'not a hydra',
    ))
    server = await startServer({ hydraId: 'default' })
    assert.deepEqual(
      Object.keys(server.skipped),
      ['not a hydra'],
    )
    const health = JSON.parse((await http({
      method: 'GET',
      path: '/health',
    })).text) as {
      hydras: string[]
      skipped: Record<string, string>
    }
    assert.deepEqual(
      health.hydras,
      [
        'default',
        'work',
      ],
    )
    assert.match(
      health.skipped['not a hydra']!,
      /invalid Hydra name/,
    )

    const work = (await readServer({ hydraId: 'work' }))!
    assert.equal(
      work.pid,
      process.pid,
    )
    assert.equal(
      work.url,
      `http://127.0.0.1:${server.port}/hydra/work/`,
    )
    const created = loadHydra({ hydraId: 'work' }).state.seq
    await sendToSocket({
      path: work.socket!,
      text: JSON.stringify(hookEvent({
        id: 'hook-1',
        key: 'a',
        title: 'A',
      })),
    })
    await seqIs({
      seq: created + 1,
      hydraId: 'work',
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      0,
    )
    const t = await tab({ hydraId: 'work' })
    const snapshot = await t.next()
    assert.equal(
      snapshot.type === 'snapshot' && snapshot.seq,
      created + 1,
    )

    cli({
      args: [
        'hydra',
        'create',
        'late',
        '--name',
        'Late',
      ],
    })
    const late = await until({
      check: () => (existsSync(infoPath({ hydraId: 'late' })) ? true : undefined),
      what: 'the new Hydra to be served',
    })
    assert.ok(late)
    assert.equal(
      (await readServer({ hydraId: 'late' }))?.url,
      `http://127.0.0.1:${server.port}/hydra/late/`,
    )
  },
)

test(
  'concurrent server starts claim one Hydra before binding their sockets',
  async () => {
    const started = await Promise.allSettled([
      startServer({ hydraId: 'default' }),
      startServer({ hydraId: 'default' }),
    ])
    const accepted = started.filter(r => r.status === 'fulfilled')
    assert.equal(
      accepted.length,
      1,
    )

    if (accepted[0]?.status === 'fulfilled') {
      server = accepted[0].value
    }

    const refused = started.find(r => r.status === 'rejected')
    assert.equal(
      refused?.status === 'rejected' && refused.reason.code,
      'ALREADY_RUNNING',
    )
    const client = await tab()
    assert.equal(
      (await client.next()).type,
      'snapshot',
    )
    client.ws.send(JSON.stringify({ type: 'ping' }))
    assert.equal(
      (await client.next()).type,
      'pong',
    )
  },
)

test(
  'Hydra and the open task keep independent live transcripts on one socket',
  async () => {
    const root = process.env.PNYX_HOME!
    const paths = [
      join(
        root,
        'worker.jsonl',
      ),
      join(
        root,
        'hydra.jsonl',
      ),
    ]
    paths.forEach(path => writeFileSync(
      path,
      '',
    ))
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const meta = {
          actor: 'fixture',
          at: '2026-10-15T00:00:00Z',
        }

        for (const [
          key,
          path,
        ] of [
            [
              'worker',
              paths[0],
            ],
            [
              'hydra-session',
              paths[1],
            ],
          ] as const) {
          const decision = decidePush({
            state: writer.state,
            newCardId: `c${writer.state.seq + 1}`,
            key,
            input: {
              title: key,
              agent: {
                provider: 'claude-code',
                sessionId: key,
                transcriptPath: path,
              },
            },
            meta,
          })
          assert.ok('event' in decision); writer.append({ event: decision.event })
        }

        const decision = hydraEvent({
          state: writer.state,
          meta,
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...hydraConfig({ state: writer.state }),
              hydra: {
                id: 'hydra',
                kind: 'agent',
                name: 'Hydra',
                session: 'claude-code:hydra-session',
              },
            },
          },
        })
        assert.ok('event' in decision); writer.append({ event: decision.event })
      },
    })
    const task = loadHydra({ hydraId: 'default' }).state.keys.worker!
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()

    const subscribe = async ({
      id,
      card,
    }: {
      id: string
      card: string
    }) => {
      t.command({
        id,
        name: 'thread',
        args: [card],
      })

      for (;;) {
        const message = await t.next()

        if (message.type === 'error' && message.id === id) {
          assert.fail(message.error)
        }

        if (message.type === 'receipt' && message.id === id) {
          return
        }
      }
    }

    await subscribe({
      id: 'worker-thread',
      card: task,
    })
    await subscribe({
      id: 'hydra-thread',
      card: HYDRA_CARD,
    })
    paths.forEach((
      path,
      index,
    ) => appendFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        message: { content: `live reply ${index}` },
      }) + '\n',
    ))
    const changed = new Set<string>()

    while (changed.size < 2) {
      const message = await t.next()

      if (message.type === 'thread' && message.thread.entries.some(e => e.text.startsWith('live reply'))) {
        changed.add(message.thread.card)
      }
    }

    assert.deepEqual(
      [...changed].sort(),
      [
        HYDRA_CARD,
        task,
      ].sort(),
    )
  },
)

test(
  'hydra-scoped search returns Hydra messages and validates command searches',
  async () => {
    seedWebFixture({ home: process.env.PNYX_HOME! })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'hydra-lunch',
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
            cardId: '$board',
            type: 'hydra.message',
            data: {
              action: 'send',
              text: 'Review this after lunch.',
              hydra: 'hydra',
            },
          },
        })
      },
    })
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()
    t.command({
      id: 'oracle',
      name: 'oracle',
      args: [
        'lunch',
        '',
        'hydra',
      ],
    })
    let result = await t.next()

    while (!((result.type === 'receipt' || result.type === 'error') && result.id === 'oracle')) {
      result = await t.next()
    }

    assert.equal(
      result.type,
      'receipt',
    )

    if (result.type === 'receipt') {
      assert.deepEqual(
        (result.hits as {
          card: string
          kind?: string
        }[]).map(hit => [
          hit.card,
          hit.kind,
        ]),
        [
          [
            '$board',
            'hydra',
          ],
        ],
      )
    }

    t.command({
      id: 'commands-off',
      name: 'oracle-commands',
      args: [
        'theme',
        JSON.stringify([
          {
            id: 'theme',
            text: 'Choose a dark theme',
          },
        ]),
      ],
    })

    do {
      result = await t.next()
    } while (!((result.type === 'receipt' || result.type === 'error') && result.id === 'commands-off'))

    assert.equal(
      result.type,
      'receipt',
    )

    if (result.type === 'receipt') {
      assert.deepEqual(
        result.matches,
        [],
      )
    }

    t.command({
      id: 'commands-invalid',
      name: 'oracle-commands',
      args: [
        'theme',
        JSON.stringify([
          {
            id: 'theme',
            text: 42,
          },
        ]),
      ],
    })

    do {
      result = await t.next()
    } while (!((result.type === 'receipt' || result.type === 'error') && result.id === 'commands-invalid'))

    assert.equal(
      result.type,
      'error',
    )

    if (result.type === 'error') {
      assert.equal(
        result.code,
        'VALIDATION_ERROR',
      )
    }

    t.ws.close()
  },
)

test(
  'a server lock whose pid was reused is reclaimed',
  async () => {
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    const path = join(
      dir,
      'server.lock',
    )
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        processStart: 'a previous boot',
      }),
    )
    server = await startServer({ hydraId: 'default' })
    const owner = JSON.parse(readFileSync(
      path,
      'utf8',
    ))
    assert.equal(
      owner.pid,
      process.pid,
    )
    assert.notEqual(
      owner.processStart,
      'a previous boot',
    )
    await assert.rejects(
      startServer({ hydraId: 'default' }),
      { code: 'ALREADY_RUNNING' },
    )
  },
)

test(
  'a Hydra another live server holds is skipped, then served once that server is gone',
  async () => {
    const other = spawn(
      process.execPath,
      [
        '-e',
        'setTimeout(() => {}, 600000)',
      ],
      { stdio: 'ignore' },
    )
    track({ child: other })
    const dir = hydraDir({ hydraId: 'held' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    writeFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      '',
    )
    const started = execFileSync(
      'ps',
      [
        '-o',
        'lstart=',
        '-p',
        String(other.pid),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TZ: 'UTC',
          LC_ALL: 'C',
        },
      },
    ).trim()
    writeFileSync(
      join(
        dir,
        'server.lock',
      ),
      JSON.stringify({
        pid: other.pid,
        processStart: started,
      }),
    )
    server = await startServer({ hydraId: 'default' })
    assert.match(
      server.skipped.held!,
      /already owns Hydra held/,
    )
    other.kill()
    await once(
      other,
      'exit',
    )
    // Any change to the Hydra folders, or the periodic retry, tries a skipped Hydra again.
    mkdirSync(hydraDir({ hydraId: 'another' }))
    await until({
      check: () => (existsSync(infoPath({ hydraId: 'held' })) ? true : undefined),
      what: 'the freed Hydra to be served',
    })
  },
)

test(
  'idle Done expiry broadcasts hiding and survives a server restart',
  async () => {
    cli({
      args: [
        'hydra',
        'create',
        'default',
        '--done-after-hours',
        '0',
      ],
    })
    cli({
      args: [
        'task',
        'create',
        '--key',
        'expire',
        '--title',
        'Idle completion',
        '--column',
        'done',
      ],
    })
    const id = loadHydra({ hydraId: 'default' }).state.keys.expire!
    server = await startServer({ hydraId: 'default' })
    cli({
      args: [
        'hydra',
        'set',
        '--done-after-hours',
        '0.0003',
      ],
    })
    await until({
      check: () => loadHydra({ hydraId: 'default' }).state.cards[id]?.hidden || undefined,
      what: 'idle Done expiry',
    })
    await server.close()
    server = await startServer({ hydraId: 'default' })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[id]?.hidden,
      true,
    )
    cli({
      args: [
        'task',
        'unhide',
        id,
      ],
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[id]?.keepDone,
      true,
    )
  },
)
