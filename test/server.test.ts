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

test(
  'polling timeout names the condition even when the expected Hydra never appears',
  async t => {
    let now = 0
    t.mock.method(
      Date,
      'now',
      () => now,
    )
    await assert.rejects(
      until({
        hydraId: 'missing-hydra',
        what: 'the missing Hydra server files',
        check: () => {
          now = TIMEOUT_MS

          return undefined
        },
      }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(
          error.message,
          /timed out waiting for the missing Hydra server files/,
        )
        const diagnostic = JSON.parse(error.message.split('server files: ')[1]!)
        assert.equal(
          diagnostic.hydraId,
          'missing-hydra',
        )
        assert.equal(
          diagnostic.state.seq,
          0,
        )
        assert.deepEqual(
          diagnostic.lastMessages,
          [],
        )

        return true
      },
    )
  },
)

test(
  'message waits keep one deadline under unrelated traffic and report their Hydra state',
  async t => {
    const hydraId = 'message-watchdog'
    cli({
      args: [
        'hydra',
        'create',
        hydraId,
        '--helper',
        'off',
      ],
    })
    const messages = inbox<ServerMessage>()
    messages.put({ message: { type: 'pong' } })
    let now = 0
    const clock = t.mock.method(
      Date,
      'now',
      () => now,
    )

    try {
      await assert.rejects(
        waitForMessage({
          hydraId,
          what: 'the expected server event',
          ms: 20,
          next: async ({ ms }) => {
            const message = await messages.next({ ms })
            now += 10
            messages.put({ message: { type: 'pong' } })

            return message
          },
          matches: ({ message }) => message.type === 'event',
        }),
        error => {
          assert.ok(error instanceof Error)
          const prefix = 'timed out waiting for the expected server event: '
          assert.ok(error.message.startsWith(prefix))
          const diagnostic = JSON.parse(error.message.slice(prefix.length))
          assert.equal(
            diagnostic.hydraId,
            hydraId,
          )
          assert.equal(
            diagnostic.state.seq,
            loadHydra({ hydraId }).state.seq,
          )
          assert.deepEqual(
            diagnostic.lastMessages,
            [
              { type: 'pong' },
              { type: 'pong' },
            ],
          )

          return true
        },
      )
    } finally {
      clock.mock.restore()
    }
  },
)

test(
  'a named message wait expires despite continuous unrelated frames',
  { timeout: 1000 },
  async () => {
    const hydraId = 'message-watchdog-live'
    cli({
      args: [
        'hydra',
        'create',
        hydraId,
        '--helper',
        'off',
      ],
    })
    await assert.rejects(
      waitForMessage({
        hydraId,
        what: 'the withheld snapshot',
        ms: 20,
        next: async () => {
          await new Promise(resolve => setImmediate(resolve))

          return { type: 'pong' }
        },
        matches: ({ message }) => message.type === 'snapshot',
      }),
      /timed out waiting for the withheld snapshot/,
    )
  },
)

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
  'a Hydra that failed to load answers its pages with 404 and the reason, never a redirect',
  async () => {
    mkdirSync(
      hydraDir({ hydraId: 'broken' }),
      { recursive: true },
    )
    writeFileSync(
      join(
        hydraDir({ hydraId: 'broken' }),
        'events.jsonl',
      ),
      'not json\n',
    )
    server = await startServer({ hydraId: 'default' })
    const response = await http({
      method: 'GET',
      path: '/hydra/broken/task/1',
    })
    assert.equal(
      response.status,
      404,
    )
    assert.ok((JSON.parse(response.text) as { reason?: string }).reason)
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
  'a server.json whose pid is gone counts as not running at once, even when its port accepts and never answers',
  async () => {
    const gone = spawn(
      process.execPath,
      [
        '-e',
        '',
      ],
      { stdio: 'ignore' },
    )
    await once(
      gone,
      'exit',
    )
    const silent = createServer(() => {}).listen(
      0,
      '127.0.0.1',
    )
    await once(
      silent,
      'listening',
    )
    const port = (silent.address() as { port: number }).port
    mkdirSync(
      hydraDir({ hydraId: 'default' }),
      { recursive: true },
    )
    writeFileSync(
      infoPath({ hydraId: 'default' }),
      JSON.stringify({
        pid: gone.pid,
        port,
        url: `http://127.0.0.1:${port}/hydra/default/`,
        socket: null,
      }),
    )

    try {
      const asked = Date.now()
      assert.equal(
        await readServer({ hydraId: 'default' }),
        null,
      )
      assert.ok(Date.now() - asked < 5000)
    } finally {
      silent.close()
    }
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
    assert.deepEqual(
      [
        (await t.next()).type,
        (await t.next()).type,
      ],
      [
        'event',
        'receipt',
      ],
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
      (await t.reply({ id: 'move-1' })).type,
      'receipt',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[card]?.column,
      'custom:later',
    )
    t.command({
      id: 'thread-1',
      name: 'thread',
      args: [card],
    })
    assert.equal(
      ((await t.reply({ id: 'thread-1' })) as { thread?: { route: boolean } }).thread?.route,
      false,
    )
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

    for (const [
      name,
      args,
      code,
    ] of [
        [
          'view',
          [
            'set',
            '--json',
            '{"fontSize":18}',
            '--if-revision',
            '0',
          ],
          'REVISION_CONFLICT',
        ],
        [
          'reply',
          [
            card,
            'test',
            'id',
          ],
          'NO_ROUTE',
        ],
        [
          'agent',
          [
            card,
            'effort',
            'high',
          ],
          'VALIDATION_ERROR',
        ],
        [
          'history',
          [
            '--card',
            card,
          ],
          undefined,
        ],
      ] as const) {
      t.command({
        id: name,
        name,
        args: [...args],
      })
      assert.equal(
        ((await t.reply({ id: name })) as { code?: string }).code,
        code,
        name,
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
        [
          card === one ? '/skill-one' : '/skill-two',
          '/compact',
        ],
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

    const send = async ({
      id,
      name,
      args,
    }: {
      id: string
      name: string
      args: string[]
    }) => {
      t.command({
        id,
        name,
        args: [
          card,
          ...args,
        ],
      })

      return await t.reply({ id }) as {
        code?: string
        error?: string
        reply?: {
          state: string
          sent: boolean
        }
        agent?: { sent: string }
      }
    }

    const args = [
      'A literal fixture reply',
      'unknown-reply',
    ]
    assert.equal(
      (await send({
        id: 'send-1',
        name: 'reply',
        args,
      })).reply?.state,
      'delivery_unknown',
    )
    assert.equal(
      (await send({
        id: 'send-2',
        name: 'reply',
        args,
      })).reply?.sent,
      false,
      'an unknown result is never sent again',
    )

    const sends = readFileSync(
      join(
        fixture.nativeHome,
        'sent.log',
      ),
      'utf8',
    )
    assert.equal(
      sends.match(/A literal fixture reply/g)?.length,
      1,
    )
    assert.equal(
      (await send({
        id: 'send-3',
        name: 'reply',
        args: [
          '   ',
          'blank-reply',
        ],
      })).code,
      'VALIDATION_ERROR',
    )
    assert.equal(
      (await send({
        id: 'agent-1',
        name: 'agent',
        args: [
          'effort',
          'high',
          'effort-1',
        ],
      })).agent?.sent,
      'delivered',
    )
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
    assert.match(
      (await send({
        id: 'answer-1',
        name: 'answer',
        args: [
          '-hook:tool:Bash',
          '{"choice":"allow"}',
          'answer-1',
          '-seen',
        ],
      })).error ?? '',
      /no open request with key -hook:tool:Bash/,
    )
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

const toolLine = ({
  record,
  at,
}: {
  record: Record<string, unknown>
  at: string
}) => JSON.stringify({
  timestamp: at,
  ...record,
}) + '\n'

test(
  'each card gets what its agent is running, pushed on connect and again when the call returns',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    appendFileSync(
      fixture.transcript,
      toolLine({
        record: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_run',
                name: 'Bash',
                input: { command: 'pnpm test' },
              },
            ],
          },
        },
        at: '2026-10-13T11:00:00Z',
      }),
    )
    server = await startServer({ hydraId: 'default' })
    const t = await tab(); await t.next()
    assert.deepEqual(
      await t.action({ card }),
      {
        calls: [
          {
            id: 'toolu_run',
            tool: 'Bash',
            command: 'pnpm test',
          },
        ],
        done: false,
        at: '2026-10-13T11:00:00Z',
      },
    )
    appendFileSync(
      fixture.transcript,
      toolLine({
        record: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_run',
                content: 'ok',
              },
            ],
          },
        },
        at: '2026-10-13T11:00:05Z',
      }),
    )
    assert.equal(
      (await t.action({ card }))?.done,
      true,
    )
    writeFileSync(
      fixture.transcript,
      assistantLine({
        text: 'Started over.',
        at: '2026-10-13T11:01:00Z',
      }),
    )
    assert.equal(
      await t.action({ card }),
      null,
    )
    t.ws.close()
  },
)

test(
  'a working card and its open conversation follow a transcript its agent keeps open, as Codex does, even under a Firstmate status',
  async () => {
    const hydraId = 'open-transcript'
    cli({
      args: [
        'hydra',
        'create',
        hydraId,
        '--helper',
        'off',
      ],
    })
    const transcript = join(
      process.env.PNYX_HOME!,
      'rollout.jsonl',
    )
    const reply = ({
      text,
      at,
    }: {
      text: string
      at: string
    }) => toolLine({
      record: {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
            },
          ],
        },
      },
      at,
    })
    writeFileSync(
      transcript,
      reply({
        text: 'Starting.',
        at: '2026-10-13T10:59:00Z',
      }),
    )
    const rollout = openSync(
      transcript,
      'a',
    )
    const input = join(
      process.env.PNYX_HOME!,
      'input.json',
    )

    const push = ({ fields }: { fields: Record<string, unknown> }) => {
      writeFileSync(
        input,
        JSON.stringify(fields),
      )
      cli({
        args: [
          'push',
          '--key',
          'work',
          '--file',
          input,
          '--hydra',
          hydraId,
        ],
      })
    }

    try {
      cli({
        args: [
          'task',
          'create',
          '--key',
          'work',
          '--title',
          'Work',
          '--hydra',
          hydraId,
        ],
      })
      push({
        fields: {
          agent: {
            provider: 'codex',
            sessionId: 'rollout',
            transcriptPath: transcript,
          },
          activity: 'working',
          source: {
            adapter: 'hooks',
            objectId: 'rollout',
          },
        },
      })
      // Firstmate's status line replaces the card's activity; the session's own stays working.
      push({
        fields: {
          activity: 'progress: running tests',
          source: {
            adapter: 'firstmate',
            instanceId: process.env.PNYX_HOME!,
            objectId: 'work',
          },
        },
      })
      const card = loadHydra({ hydraId }).state.keys.work!
      server = await startServer({ hydraId })
      const t = await tab({ hydraId }); await t.next()
      assert.equal(
        (await t.latest({ card }))?.text,
        'Starting.',
      )
      t.command({
        id: 'thread-1',
        name: 'thread',
        args: [card],
      })
      assert.equal(
        (await t.reply({ id: 'thread-1' })).type,
        'receipt',
      )
      writeSync(
        rollout,
        reply({
          text: 'Running the tests.',
          at: '2026-10-13T11:00:00Z',
        }) + toolLine({
          record: {
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'exec_command',
              call_id: 'call_run',
              arguments: JSON.stringify({ cmd: 'pnpm test' }),
            },
          },
          at: '2026-10-13T11:00:00Z',
        }),
      )
      assert.deepEqual(
        await t.action({ card }),
        {
          calls: [
            {
              id: 'call_run',
              tool: 'exec_command',
              command: 'pnpm test',
            },
          ],
          done: false,
          at: '2026-10-13T11:00:00Z',
        },
      )

      await t.waitForMessage({
        what: 'the open conversation to show the running rollout',
        matches: ({ message }) => message.type === 'thread'
          && message.thread.entries.some(entry => entry.text === 'Running the tests.'),
      })

      writeSync(
        rollout,
        toolLine({
          record: {
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_run',
              output: 'ok',
            },
          },
          at: '2026-10-13T11:00:05Z',
        }),
      )
      assert.equal(
        (await t.action({ card }))?.done,
        true,
      )

      push({
        fields: {
          activity: 'finished',
          source: {
            adapter: 'hooks',
            objectId: 'rollout',
          },
        },
      })

      await t.waitForMessage({
        what: 'the rollout hooks source to finish its activity',
        matches: ({ message }) => message.type === 'event'
          && message.event.type === 'card.pushed'
          && message.event.cardId === card
          && message.event.data.activity === 'finished'
          && message.event.data.source?.adapter === 'hooks'
          && message.event.data.source.objectId === 'rollout',
      })

      writeSync(
        rollout,
        reply({
          text: 'Finished; the open conversation still follows.',
          at: '2026-10-13T11:00:10Z',
        }),
      )

      await t.waitForMessage({
        what: 'the open conversation to follow the finished rollout',
        matches: ({ message }) => message.type === 'thread'
          && message.thread.entries.some(entry => entry.text === 'Finished; the open conversation still follows.'),
      })

      t.ws.close()
    } finally {
      closeSync(rollout)
    }
  },
)

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

test(
  'latest messages carry task tokens and refresh usage without a Hydra event or changed reply',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    const at = new Date().toISOString()
    const usageLine = ({ tokens }: { tokens: number }) => `${JSON.stringify({
      type: 'assistant',
      timestamp: at,
      message: {
        id: 'usage-message',
        content: [
          {
            type: 'text',
            text: 'Working.',
          },
        ],
        usage: {
          input_tokens: tokens,
          output_tokens: 0,
        },
      },
    })}\n`
    writeFileSync(
      fixture.transcript,
      usageLine({ tokens: 40 }),
    )
    server = await startServer({ hydraId: 'default' })
    const t = await tab()
    await t.next()
    assert.equal(
      (await t.spend())[card]?.total,
      40,
    )
    const later = await tab()
    await later.next()
    assert.equal(
      (await later.spend())[card]?.total,
      40,
    )
    later.ws.close()
    const seq = loadHydra({ hydraId: 'default' }).state.seq
    appendFileSync(
      fixture.transcript,
      usageLine({ tokens: 70 }),
    )

    await t.waitForSpend({
      what: `token total 70 for ${card}`,
      matches: ({ message }) => message[card]?.total === 70,
    })

    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      seq,
    )
    await t.idle()
    t.ws.close()
  },
)

test(
  'large-transcript token counting stays off the server event loop while health checks succeed',
  async context => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    const at = new Date().toISOString()
    const usage = ({
      from,
      count,
    }: {
      from: number
      count: number
    }) => Array.from(
      { length: count },
      (
        _,
        i,
      ) => `${JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
          id: `usage-${from + i}`,
          content: [
            {
              type: 'text',
              text: 'Counting a long transcript.',
            },
          ],
          usage: {
            input_tokens: 2,
            output_tokens: 1,
          },
        },
      })}\n`,
    ).join('')
    writeFileSync(
      fixture.transcript,
      usage({
        from: 0,
        count: 1,
      }),
    )
    server = await startServer({ hydraId: 'default' })
    const t = await tab()
    await t.next()
    assert.equal(
      (await t.spend())[card]?.total,
      3,
    )
    const records = 200_000
    const grown = usage({
      from: 1,
      count: records,
    })
    const parses = context.mock.method(
      JSON,
      'parse',
    )
    context.after(() => parses.mock.restore())
    appendFileSync(
      fixture.transcript,
      grown,
    )
    let counted = false
    const spend = t.waitForSpend({
      what: `token total ${(records + 1) * 3} for ${card}`,
      matches: ({ message }) => message[card]?.total === (records + 1) * 3,
    }).finally(() => {
      counted = true
    })
    const checks: boolean[] = []
    const [tokenTotals] = await Promise.all([
      spend,
      until({
        hydraId: 'default',
        what: 'token counting to finish while server health remains available',
        check: async () => {
          checks.push(!!await readServer({ hydraId: 'default' }))

          return counted || undefined
        },
      }),
    ])
    assert.equal(
      tokenTotals[card]?.total,
      (records + 1) * 3,
    )
    assert.ok(checks.length > 0 && checks.every(Boolean))
    // A worker has its own JSON object; the server may parse the tail, but never the first growth row.
    assert.ok(
      parses.mock.calls.every(call => !String(call.arguments[0]).includes('"id":"usage-1"')),
      'the server parsed transcript growth on its own event loop',
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
  'a stopped server leaves no open handles, even with Hydra and transcript changes still in flight',
  async () => {
    const fixture = seedWebFixture({ home: process.env.PNYX_HOME! })
    const card = fixture.state.keys.layout!
    const input = join(
      process.env.PNYX_HOME!,
      'input.json',
    )
    writeFileSync(
      input,
      JSON.stringify({ activity: 'working' }),
    )
    // A working card's transcript file is watched as well as its folder.
    cli({
      args: [
        'push',
        '--key',
        'layout',
        '--file',
        input,
      ],
    })
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

    const receipts = new Set<string>()
    await t.waitForMessage({
      what: 'the thread and Oracle receipts before shutdown',
      matches: ({ message }) => {
        if (message.type === 'receipt' && (message.id === 'thread-1' || message.id === 'oracle-1')) {
          receipts.add(message.id)
        }

        return receipts.size === 2
      },
    })

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
      const threadFrom = ({ message }: { message: ServerMessage }) => message.type === 'thread' ? message.thread
        : message.type === 'receipt' ? message.thread as import('../src/thread/read.ts').ThreadPage | undefined
          : undefined
      const message = await t.waitForMessage({
        what: `thread session ${session ?? 'none'}${text ? ` containing ${text}` : ''}`,
        matches: ({ message }) => {
          const thread = threadFrom({ message })

          return Boolean(thread && thread.session === session
            && (!text || thread.entries.some(entry => entry.text.includes(text))))
        },
      })
      const thread = threadFrom({ message })
      assert.ok(thread)

      return thread
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

    const update = await t.waitForSummaries({
      what: 'the other Hydra project with one live task and one ask',
      matches: ({ message }) => {
        const project = message.hydras.find(h => h.id === 'other')?.projects[0]

        return project?.live === 1 && project.asks === 1
      },
    })
    assert.equal(
      update.hydraId,
      'default',
    )

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
    await eventRecorded({
      hydraId: 'work',
      what: 'the hook on the work Hydra',
      matches: ({ event }) => event.id === 'hook-1',
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
      hydraId: 'late',
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
    assert.deepEqual(
      ((await t.reply({ id: 'oracle' })) as {
        hits?: {
          card: string
          kind?: string
        }[]
      }).hits!.map(hit => [
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

    for (const [
      id,
      text,
      expected,
    ] of [
        [
          'commands-off',
          'Choose a dark theme',
          { matches: [] },
        ],
        [
          'commands-invalid',
          42,
          { code: 'VALIDATION_ERROR' },
        ],
      ] as const) {
      t.command({
        id,
        name: 'oracle-commands',
        args: [
          'theme',
          JSON.stringify([
            {
              id: 'theme',
              text,
            },
          ]),
        ],
      })
      assert.partialDeepStrictEqual(
        await t.reply({ id }),
        expected,
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
      hydraId: 'held',
      check: () => (existsSync(infoPath({ hydraId: 'held' })) ? true : undefined),
      what: 'the freed Hydra to be served',
    })
  },
)

test(
  'a running server hides an idle Done task when its delay passes, with no other event',
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
      hydraId: 'default',
      check: () => loadHydra({ hydraId: 'default' }).state.cards[id]?.hidden || undefined,
      what: 'idle Done expiry',
    })
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
    t.ws.close()
  },
)

test(
  'the server follows a task\'s open pull request and records the checks gh-axi reports',
  async () => {
    await hydraWithCard()
    const created = cli({
      args: [
        'task',
        'create',
        '--title',
        'Ship the export',
      ],
    })
    const taskId = /id: (task-[0-9a-f-]+)/.exec(created)![1]!
    const url = 'https://github.com/o/r/pull/77'
    cli({
      args: [
        'link',
        taskId,
        '--url',
        url,
        '--state',
        'open',
      ],
    })

    const checks = await until({
      hydraId: 'default',
      check: () => loadHydra({ hydraId: 'default' }).state.cards[taskId]?.links.find(l => l.url === url)?.checks,
      what: 'the followed pull request\'s checks',
    })
    assert.equal(
      checks,
      '0 passed, 0 failed',
    )
  },
)

test(
  'one scoped socket follows two Hydras and routes writes without changing their CLI scope',
  async () => {
    cli({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    cli({
      args: [
        'hydra',
        'create',
        'other',
        '--name',
        'Other',
      ],
    })
    server = await startServer({
      hydraId: 'default',
      port: 0,
    })
    const t = await tab({ query: '?scoped=1' })
    assert.equal(
      t.hello.scope,
      'default',
    )
    await t.next()
    t.ws.send(JSON.stringify({
      type: 'subscribe',
      scope: 'other',
      subscription: 'other-v1',
    }))
    const snapshot = await waitForMessage({
      next: t.next,
      hydraId: 'other',
      what: 'the other Hydra snapshot',
      matches: ({ message }) => message.type === 'snapshot' && message.scope === 'other',
    })
    assert.ok(snapshot.type === 'snapshot')

    assert.equal(
      snapshot.state.config?.id,
      'other',
    )
    assert.equal(
      snapshot.subscription,
      'other-v1',
    )
    t.ws.send(JSON.stringify({
      type: 'command',
      scope: 'other',
      id: 'other-rename',
      name: 'hydra',
      args: [
        'set',
        '--name',
        'Changed',
        '--event-id',
        'other-event',
      ],
    }))
    let receipt = await waitForMessage({
      next: t.next,
      hydraId: 'other',
      what: 'the scoped rename receipt',
      matches: ({ message }) => 'id' in message && message.id === 'other-rename',
    })

    assert.equal(
      receipt.type,
      'receipt',
    )
    assert.equal(
      receipt.scope,
      'other',
    )
    assert.equal(
      loadHydra({ hydraId: 'other' }).state.config?.name,
      'Changed',
    )
    assert.notEqual(
      loadHydra({ hydraId: 'default' }).state.config?.name,
      'Changed',
    )
    t.ws.send(JSON.stringify({
      type: 'command',
      scope: 'other',
      id: 'bad-scope',
      name: 'hydra',
      args: [
        'set',
        '--name',
        'Wrong',
        '--hydra',
        'default',
      ],
    }))

    receipt = await waitForMessage({
      next: t.next,
      hydraId: 'other',
      what: 'the conflicting scope refusal',
      matches: ({ message }) => 'id' in message && message.id === 'bad-scope',
    })

    assert.equal(
      receipt.type,
      'error',
    )
    t.ws.send(JSON.stringify({
      type: 'subscribe',
      scope: 'missing',
    }))

    receipt = await waitForMessage({
      next: t.next,
      hydraId: 'default',
      what: 'the missing Hydra refusal',
      matches: ({ message }) => message.type === 'scope-error',
    })

    assert.equal(
      receipt.scope,
      'missing',
    )
    assert.equal(
      t.ws.readyState,
      WebSocket.OPEN,
    )
  },
)

test(
  'creation keeps its saved identity when mounting fails and retry uses the same allocation',
  async () => {
    cli({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    server = await startServer({
      hydraId: 'default',
      port: 0,
    })
    const t = await tab({ query: '?scoped=1' })
    await t.next()
    const write = fs.writeFileSync
    const broken = hydraDir({ hydraId: 'hydra-2' })
    // eslint-disable-next-line pnyx/object-params -- writeFileSync owns its overloaded arguments.
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).startsWith(join(
        broken,
        'server.json.tmp-',
      ))) {
        throw new Error('Synthetic mount failure')
      }

      return write(...args)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()

    try {
      t.command({
        id: 'saved-create',
        name: 'hydras',
        args: [
          'create',
          'Saved',
          'mount-failure',
        ],
      })
      const receipt = await t.reply({ id: 'saved-create' }) as Extract<ServerMessage, { type: 'receipt' }>
      assert.equal(
        (receipt.creation as { hydraId: string }).hydraId,
        'hydra-2',
      )
      assert.equal(
        (receipt.creation as { status: string }).status,
        'saved',
      )
      t.ws.send(JSON.stringify({
        type: 'subscribe',
        scope: 'hydra-2',
      }))
      const result = await waitForMessage({
        next: t.next,
        hydraId: 'hydra-2',
        what: 'the saved Hydra mount failure',
        matches: ({ message }) => message.type === 'scope-error',
      })
      assert.ok(result.type === 'scope-error')

      assert.equal(
        result.scope,
        'hydra-2',
      )
      assert.match(
        result.error,
        /Synthetic mount failure/,
      )
      assert.equal(
        loadHydra({ hydraId: 'hydra-2' }).state.config?.name,
        'Saved',
      )
      const response = await fetch(`http://127.0.0.1:${server.port}/hydra/hydra-2/`)
      assert.equal(
        response.status,
        200,
      )
      assert.match(
        await response.text(),
        /pnyx-token/,
      )
      assert.equal(
        t.ws.readyState,
        WebSocket.OPEN,
      )
    } finally {
      fs.writeFileSync = write
      syncBuiltinESMExports()
    }

    t.ws.send(JSON.stringify({
      type: 'subscribe',
      scope: 'hydra-2',
    }))
    const snapshot = await waitForMessage({
      next: t.next,
      hydraId: 'hydra-2',
      what: 'the recovered saved Hydra snapshot',
      matches: ({ message }) => message.type === 'snapshot' && message.scope === 'hydra-2',
    })
    assert.ok(snapshot.type === 'snapshot')

    assert.equal(
      snapshot.state.config?.name,
      'Saved',
    )
    t.command({
      id: 'saved-retry',
      name: 'hydras',
      args: [
        'create',
        'Ignored retry name',
        'mount-failure',
      ],
    })
    const retried = await t.reply({ id: 'saved-retry' }) as Extract<ServerMessage, { type: 'receipt' }>
    assert.equal(
      (retried.creation as { hydraId: string }).hydraId,
      'hydra-2',
    )
    assert.equal(
      loadHydra({ hydraId: 'hydra-2' }).state.seq,
      1,
    )
  },
)
