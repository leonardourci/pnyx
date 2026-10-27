import { MAX_MESSAGE_BYTES } from '../src/server/protocol.ts'
import { seedWebFixture } from './web-fixture.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { WebSocket } from 'ws'
import { allowedRequest, startServer, type RunningServer, type ServerMessage } from '../src/server/server.ts'
import { infoPath, localToken, readServer, socketPath } from '../src/server/state.ts'
import { acquireLock, hydraDir, hydrasDir, loadHydra, readEvents, spoolDir, spoolWrite, withWriter } from '../src/store/hydra-store.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { decidePush } from '../src/core/decide.ts'
import { indexStatus, searchPath } from '../src/oracle/index.ts'
import { stopAll, track } from './processes.ts'
import type { HydraSummary } from '../src/server/hydras.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'
// The server follows linked pull requests; these tests never reach GitHub.
process.env.PNYX_GH_AXI = join(
  import.meta.dirname,
  'fixtures/github/gh-axi.sh',
)

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// Waits end as soon as their condition holds; the bound only has to outlast a heavily loaded machine.
const TIMEOUT_MS = 30000
const watchdog = setTimeout
const clearWatchdog = clearTimeout
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

function waitDiagnostic({
  hydraId,
  lastMessages,
}: {
  hydraId: string
  lastMessages?: unknown[]
}) {
  try {
    return {
      hydraId,
      state: loadHydra({ hydraId }).state,
      lastMessages: lastMessages ?? readEvents({ hydraId }).slice(-10),
    }
  } catch (error) {
    return {
      hydraId,
      error: String(error),
      lastMessages: lastMessages ?? [],
    }
  }
}

async function until<T>({
  check,
  what,
  hydraId,
}: {
  check: () => T | undefined | Promise<T | undefined>
  what: string
  hydraId: string
}): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS

  while (Date.now() < deadline) {
    const value = await check()

    if (value !== undefined) {
      return value
    }

    await new Promise(r => setTimeout(
      r,
      20,
    ))
  }

  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(waitDiagnostic({ hydraId }))}`)
}

const eventRecorded = ({
  hydraId,
  matches,
  what,
}: {
  hydraId: string
  matches({ event }: { event: import('../src/core/model.ts').HydraEvent }): boolean
  what: string
}) => until({
  hydraId,
  check: () => readEvents({ hydraId }).find(event => matches({ event })),
  what,
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
          const timer = watchdog(
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
            clearWatchdog(timer)
            resolve(m)
          }

          waiting.push(waiter)
        }),
  }
}

type LatestMessages = Extract<ServerMessage, { type: 'latest' }>['messages']
type LatestActions = Extract<ServerMessage, { type: 'latest' }>['actions']

async function waitForMessage<T>({
  next,
  hydraId,
  what,
  matches,
  ms = TIMEOUT_MS,
}: {
  next({ ms }: { ms: number }): Promise<T>
  hydraId: string
  what: string
  matches({ message }: { message: T }): boolean
  ms?: number
}): Promise<T> {
  const deadline = Date.now() + ms
  const lastMessages: T[] = []
  let cause: unknown

  while (Date.now() < deadline) {
    let message: T

    try {
      message = await next({
        ms: Math.max(
          1,
          deadline - Date.now(),
        ),
      })
    } catch (error) {
      cause = error
      break
    }

    lastMessages.push(message)

    if (lastMessages.length > 10) {
      lastMessages.shift()
    }

    if (matches({ message })) {
      return message
    }
  }

  throw new Error(
    `timed out waiting for ${what}: ${JSON.stringify(waitDiagnostic({
      hydraId,
      lastMessages,
    }))}`,
    { cause },
  )
}

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
  const actions = inbox<LatestActions>()
  const spend = inbox<NonNullable<Extract<ServerMessage, { type: 'latest' }>['spend']>>()
  const summaries = inbox<Extract<ServerMessage, { type: 'hydras' }>>()
  const queue = main.queue
  ws.on(
    'message',
    data => {
      const message = JSON.parse(String(data)) as ServerMessage

      if (message.type === 'latest') {
        latest.put({ message: message.messages })
        actions.put({ message: message.actions })

        if (message.spend) {
          spend.put({ message: message.spend })
        }
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
    waitForMessage: ({
      what,
      matches,
    }: {
      what: string
      matches({ message }: { message: ServerMessage }): boolean
    }) => waitForMessage({
      next: main.next,
      hydraId,
      what,
      matches,
    }),
    summaries: summaries.next,
    spend: spend.next,
    waitForSpend: ({
      what,
      matches,
    }: {
      what: string
      matches({ message }: { message: NonNullable<Extract<ServerMessage, { type: 'latest' }>['spend']> }): boolean
    }) => waitForMessage({
      next: spend.next,
      hydraId,
      what,
      matches,
    }),
    waitForSummaries: ({
      what,
      matches,
    }: {
      what: string
      matches({ message }: { message: Extract<ServerMessage, { type: 'hydras' }> }): boolean
    }) => waitForMessage({
      next: summaries.next,
      hydraId,
      what,
      matches,
    }),
    async latest({ card }: { card: string }) {
      const messages = await waitForMessage({
        next: latest.next,
        hydraId,
        what: `the latest message for ${card}`,
        matches: ({ message }) => card in message,
      })

      return messages[card]
    },
    async action({ card }: { card: string }) {
      const pushed = await waitForMessage({
        next: actions.next,
        hydraId,
        what: `the latest action for ${card}`,
        matches: ({ message }) => card in message,
      })

      return pushed[card]
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
    // The receipt or error answering one request, past any pushes before it.
    async reply({ id }: { id: string }): Promise<Extract<ServerMessage, { type: 'receipt' | 'error' }>> {
      const message = await waitForMessage({
        next: main.next,
        hydraId,
        what: `the reply to ${id}`,
        ms: CLI_TIMEOUT_MS,
        matches: ({ message }) => (message.type === 'receipt' || message.type === 'error') && message.id === id,
      })
      assert.ok(message.type === 'receipt' || message.type === 'error')

      return message
    },
    async idle() {
      const id = `drain-${crypto.randomUUID()}`
      ws.send(JSON.stringify({
        type: 'command',
        id,
        name: 'history',
        args: [
          '--limit',
          '1',
        ],
      }))
      const unexpected: ServerMessage[] = []
      await waitForMessage({
        hydraId,
        what: `drain receipt ${id}`,
        next: ({ ms }) => main.next({ ms }),
        matches: ({ message }) => {
          if (message.type === 'receipt' && message.id === id) {
            return true
          }

          unexpected.push(message)

          return false
        },
      })
      assert.deepEqual(
        unexpected,
        [],
      )
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
  await eventRecorded({
    hydraId,
    what: 'the card hook',
    matches: ({ event }) => event.id === 'hook-1',
  })

  return loadHydra({ hydraId }).state.keys.a!
}

test(
  'serve runs until stop, and the summary reports it without starting it',
  async () => {
    assert.match(
      cli({ args: [] }),
      /^server: not running$/m,
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
      hydraId: 'default',
      check: () => /^url: "(http:\/\/127\.0\.0\.1:\d+\/hydra\/default\/)"$/m.exec(out)?.[1],
      what: 'serve to start',
    })
    await until({
      hydraId: 'default',
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
  },
)

test(
  'serve refuses a taken port from --port or PORT instead of picking another, and a PORT that is not a number',
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
        args,
        env,
        expected,
      ] of [
          [
            [
              '--port',
              String(port),
            ],
            {},
            new RegExp(`port ${port} is in use[^]*PORT_IN_USE`),
          ],
          [
            [],
            { PORT: String(port) },
            new RegExp(`port ${port} is in use`),
          ],
          [
            [],
            { PORT: 'abc' },
            /PORT must be a number/,
          ],
        ] as const) {
        const child = spawn(
          process.execPath,
          [
            BIN,
            'serve',
            ...args,
          ],
          {
            env: {
              ...process.env,
              ...env,
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
    await eventRecorded({
      hydraId: 'default',
      what: 'the first spooled hook',
      matches: ({ event }) => event.id === 'hook-1',
    })
    spoolWrite({
      hydraId: 'default',
      entry: hookEvent({
        id: 'hook-2',
        key: 'session-b',
        title: 'Spooled while it runs',
      }),
    })
    await eventRecorded({
      hydraId: 'default',
      what: 'the second spooled hook',
      matches: ({ event }) => event.id === 'hook-2',
    })
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
    await eventRecorded({
      hydraId: 'default',
      what: 'the second socket hook before resuming',
      matches: ({ event }) => event.id === 'hook-2',
    })

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
      assert.deepEqual(
        [
          reply.type,
          (reply as { id?: string }).id,
          (reply as { code?: string }).code,
        ],
        [
          'error',
          id,
          code,
        ],
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
    await eventRecorded({
      hydraId: 'work',
      what: 'the requested card move',
      matches: ({ event }) => event.type === 'card.moved' && event.cardId === cardId && event.data.after === 'done',
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

    for (const [
      request,
      status,
    ] of [
        [
          { query: '' },
          401,
        ],
        [
          { query: '?token=wrong' },
          401,
        ],
        [
          {
            query: token,
            headers: { origin: 'http://evil.example' },
          },
          403,
        ],
        [
          {
            query: token,
            headers: { origin: `http://127.0.0.1:${server.port}.evil.example` },
          },
          403,
        ],
        [
          {
            query: token,
            headers: { host: `evil.example:${server.port}` },
          },
          403,
        ],
        [
          {
            query: token,
            path: '/hydra/missing/ws',
          },
          403,
        ],
      ] as const) {
      assert.equal(
        await handshakeStatus(request),
        status,
        JSON.stringify(request),
      )
    }

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
    mkdirSync(
      hydraDir({ hydraId: 'work' }),
      { recursive: true },
    )
    appendFileSync(
      join(
        hydraDir({ hydraId: 'work' }),
        'events.jsonl',
      ),
      '',
    )
    server = await startServer({ hydraId: 'default' })
    const meta = `<meta name="pnyx-token" content="${localToken()}" />`

    for (const path of [
      '/hydra/default/',
      '/hydra/default/index.html',
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

    // Only a Hydra's own page carries the token; other unknown pages redirect home, missing files 404.
    for (const [
      method,
      path,
      status,
      location,
    ] of [
        [
          'GET',
          '/',
          302,
          '/hydra/default/',
        ],
        [
          'GET',
          '/?open-hydra=work',
          302,
          '/hydra/default/?open-hydra=work',
        ],
        [
          'GET',
          '/hydra/default',
          308,
          '/hydra/default/',
        ],
        [
          'GET',
          '/index.html',
          404,
        ],
        [
          'GET',
          '/favicon.svg',
          200,
        ],
        [
          'GET',
          '/hydra/missing/',
          404,
        ],
        [
          'GET',
          '/hydra/missing/task/1',
          404,
        ],
        [
          'GET',
          '/hydra/default/api/commands/move',
          302,
          '/hydra/default/',
        ],
        [
          'GET',
          '/hydra/work/task/1/?project=%2Ftmp%2Fx',
          302,
          '/hydra/work/?project=%2Ftmp%2Fx',
        ],
        [
          'GET',
          '/some/route?open-hydra=work',
          302,
          '/hydra/default/?open-hydra=work',
        ],
        [
          'GET',
          '/hydra/work/favicon.svg',
          200,
        ],
        [
          'GET',
          '/hydra/default/assets/missing.js',
          404,
        ],
        [
          'GET',
          '/assets/missing.js',
          404,
        ],
        [
          'POST',
          '/hydra/default/api/commands/move',
          405,
        ],
        [
          'POST',
          '/some/route',
          405,
        ],
      ] as const) {
      const response = await http({
        method,
        path,
      })
      assert.deepEqual(
        [
          response.status,
          response.headers.location,
        ],
        [
          status,
          location,
        ],
        `${method} ${path}`,
      )
    }

    const health = await http({
      method: 'GET',
      path: '/hydra/default/health',
    })
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
        hydras: [
          'default',
          'work',
        ],
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
    const installation = /name="pnyx-installation" content="([a-f0-9]{24})"/.exec(html)?.[1]
    assert.ok(installation)
    assert.deepEqual(
      (await tab()).hello,
      {
        type: 'hello',
        build,
        hydraId: identity,
        installation,
      },
    )
  },
)

test(
  'a // target redirects a GET home, refuses other methods and upgrades, and the server keeps answering',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const page = await http({
      method: 'GET',
      path: '//?open-hydra=default',
    })
    assert.deepEqual(
      [
        page.status,
        page.headers.location,
      ],
      [
        302,
        '/hydra/default/?open-hydra=default',
      ],
    )
    assert.equal(
      (await http({
        method: 'POST',
        path: '//',
      })).status,
      405,
    )
    assert.equal(
      await handshakeStatus({
        query: '',
        path: '//',
      }),
      403,
    )
    assert.equal(
      (await http({
        method: 'GET',
        path: '/health',
      })).status,
      200,
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
  'the Hydra search rebuilds a stale index and finds a card by a word only its transcript holds, including words a live session just wrote',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    writeFileSync(
      searchPath({ hydraId: 'default' }),
      'not a database',
    )
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()

    const search = async ({ text }: { text: string }) => {
      t.command({
        id: text,
        name: 'oracle',
        args: [text],
      })

      return ((await t.reply({ id: text })) as {
        hits?: {
          card: string
          match: string
        }[]
      }).hits!.map(h => [
        h.card,
        h.match,
      ])
    }

    const layout = fixture.state.keys.layout
    // "readable" is only in the transcript's first user message, not in any title, link or event.
    assert.deepEqual(
      (await search({ text: 'readable' })).map(([card]) => card),
      [layout],
    )
    assert.equal(
      indexStatus({ hydraId: 'default' })?.current,
      true,
    )
    appendFileSync(
      fixture.transcript,
      assistantLine({
        text: 'The flamingo rollout is staged behind the flag.',
        at: '2026-10-13T11:00:00Z',
      }),
    )
    assert.deepEqual(
      await search({ text: 'flamingo rollout' }),
      [
        [
          layout,
          'lexical',
        ],
      ],
    )
    assert.deepEqual(
      await search({ text: 'flamingo nowhere' }),
      [],
    )
    t.ws.close()
  },
)

for (const activity of [
  'idle',
  'working',
] as const) {
  test(
    `each card gets its conversation's last message after native notices are lost (${activity})`,
    async context => {
      const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
      const card = fixture.state.keys.layout!

      if (activity === 'working') {
        withWriter({
          hydraId: 'default',
          fn: ({ writer }) => {
            const decision = decidePush({
              state: writer.state,
              newCardId: card,
              key: 'layout',
              input: { activity },
              meta: {
                actor: 'test',
                at: new Date().toISOString(),
              },
            })
            assert.ok('event' in decision)
            writer.append({ event: decision.event })
          },
        })
      }

      const watching = context.mock.method(
        fs,
        'watch',
      )
      syncBuiltinESMExports()
      context.after(() => {
        watching.mock.restore()
        syncBuiltinESMExports()
      })
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

      // Simulate missing native notifications without changing the transcript path.
      for (const call of watching.mock.calls) {
        const path = call.arguments[0]

        if (path === fixture.transcript || path === dirname(fixture.transcript)) {
          call.result?.close()
        }
      }

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
      const replacement = `${fixture.transcript}.replacement`
      writeFileSync(
        replacement,
        readFileSync(
          fixture.transcript,
          'utf8',
        ) + assistantLine({
          text: 'Rotated.',
          at: '2026-10-13T11:03:00Z',
        }),
      )
      renameSync(
        replacement,
        fixture.transcript,
      )
      assert.deepEqual(
        await t.latest({ card }),
        {
          role: 'assistant',
          text: 'Rotated.',
          at: '2026-10-13T11:03:00Z',
        },
      )
      const later = await tab(); await later.next()
      assert.deepEqual(
        await later.latest({ card }),
        {
          role: 'assistant',
          text: 'Rotated.',
          at: '2026-10-13T11:03:00Z',
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
          text: 'Rotated.',
          at: '2026-10-13T11:03:00Z',
        },
      )
      t.ws.close(); later.ws.close()
    },
  )
}

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
  'Hydra and the open task keep independent live transcripts on one socket',
  async context => {
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
    const files = paths.map(path => openSync(
      path,
      'a',
    ))
    context.after(() => files.forEach(file => closeSync(file)))
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
      assert.equal(
        (await t.reply({ id })).type,
        'receipt',
      )
    }

    await subscribe({
      id: 'worker-thread',
      card: task,
    })
    await subscribe({
      id: 'hydra-thread',
      card: HYDRA_CARD,
    })

    for (const keepOpen of [
      false,
      true,
    ]) {
      const text = ({ index }: { index: number }) => `live reply ${index}, kept open: ${keepOpen}`
      paths.forEach((
        path,
        index,
      ) => {
        const line = JSON.stringify({
          type: 'assistant',
          message: { content: text({ index }) },
        }) + '\n'

        if (keepOpen) {
          writeSync(
            files[index]!,
            line,
          )
        } else {
          appendFileSync(
            path,
            line,
          )
        }
      })
      const changed = new Set<string>()

      await t.waitForMessage({
        what: `both live thread replies, kept open: ${keepOpen}`,
        matches: ({ message }) => {
          if (message.type !== 'thread' || (message.thread.card !== task && message.thread.card !== HYDRA_CARD)) {
            return false
          }

          const index = message.thread.card === task ? 0 : 1

          if (message.thread.entries.some(e => e.text === text({ index }))) {
            changed.add(message.thread.card)
          }

          return changed.size === 2
        },
      })

      assert.deepEqual(
        [...changed].sort(),
        [
          HYDRA_CARD,
          task,
        ].sort(),
      )
    }
  },
)

test(
  'Hydras list projects with live workers and unanswered asks, create, rename and open on the same server',
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
    server = await startServer({
      hydraId: 'default',
      port: 0,
    })
    const t = await tab()

    const receipt = async ({ id }: { id: string }) => await t.reply({ id }) as {
      hydras?: HydraSummary[]
      url?: string
      error?: string
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

    t.command({
      id: 'b6',
      name: 'hydras',
      args: ['create'],
    })
    assert.equal(
      (await receipt({ id: 'b6' })).hydras?.find(b => b.id === 'hydra-3')?.name,
      '',
    )
  },
)

test(
  'a Hydra whose folder was seen before its log is served even if directory notifications are lost',
  async t => {
    mkdirSync(
      hydraDir({ hydraId: 'late' }),
      { recursive: true },
    )
    const watching = t.mock.method(
      fs,
      'watch',
    )
    syncBuiltinESMExports()

    try {
      server = await startServer({ hydraId: 'default' })
    } finally {
      watching.mock.restore()
      syncBuiltinESMExports()
    }

    assert.match(
      server.skipped.late!,
      /unknown Hydra: late/,
    )
    const directoryWatcher = watching.mock.calls.find(
      call => call.arguments[0] === hydrasDir(),
    )?.result
    assert.ok(directoryWatcher)
    directoryWatcher.close()
    cli({
      args: [
        'hydra',
        'create',
        'late',
      ],
    })
    await until({
      hydraId: 'late',
      check: () => existsSync(infoPath({ hydraId: 'late' })) ? true : undefined,
      what: 'the completed Hydra to be served without waiting for the periodic retry',
    })
    assert.equal(
      (await readServer({ hydraId: 'late' }))?.url,
      `http://127.0.0.1:${server.port}/hydra/late/`,
    )
  },
)

test(
  'server shutdown releases its ownership without taking an active Hydra writer lock',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const dir = hydraDir({ hydraId: 'default' })
    const release = acquireLock({ dir })

    try {
      await assert.doesNotReject(server.close())
      assert.ok(!existsSync(join(
        dir,
        'server.lock',
      )))
      assert.equal(
        readFileSync(
          join(
            dir,
            'writer.lock',
          ),
          'utf8',
        ),
        String(process.pid),
      )
    } finally {
      release()
    }
  },
)

test(
  'server shutdown closes HTTP even when releasing a missing ownership claim fails',
  async () => {
    server = await startServer({ hydraId: 'default' })
    const url = server.url
    rmSync(join(
      hydraDir({ hydraId: 'default' }),
      'server.lock',
    ))
    await assert.rejects(
      server.close(),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      fetch(url),
      /fetch failed/,
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
      hydraId: 'held',
      check: () => (existsSync(infoPath({ hydraId: 'held' })) ? true : undefined),
      what: 'the freed Hydra to be served',
    })
  },
)
