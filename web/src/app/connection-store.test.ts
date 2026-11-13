import { threadDelta } from '#hydra/thread-delta.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { createHydraConnection } from './connection-store.ts'
import { hydraSource } from '#web-app/fixtures/hydra-source.ts'

const hydras = hydraSource()
import { emptyHydra } from '#app/reducer.ts'

class TestSocket {
  static OPEN = 1
  static current: TestSocket
  readyState = 1
  // eslint-disable-next-line pnyx/object-params -- WebSocket callback contract.
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  onopen?: () => void
  sent: Record<string, unknown>[] = []

  token: string | null
  page: unknown
  // eslint-disable-next-line pnyx/object-params -- WebSocket owns the constructor signature.
  constructor(url: URL) {
    this.token = url.searchParams.get('token')
    this.page = JSON.parse(url.searchParams.get('page') ?? 'null')
    TestSocket.current = this
  }

  // eslint-disable-next-line pnyx/object-params -- WebSocket send contract.
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.readyState = 3
  }

  receive({ message }: { message: Record<string, unknown> }) {
    this.onmessage?.({
      data: JSON.stringify({
        scope: 'default',
        ...message,
      }),
    })
  }
}

// Stands in for the page's browser globals for one test, over the given session storage.
function installPage({
  t,
  sessionStorage,
}: {
  t: TestContext
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}) {
  const events = new EventTarget()
  const token = {
    content: 'fixture',
    // eslint-disable-next-line pnyx/object-params -- Element owns the attribute signature.
    setAttribute(
      _name: string,
      value: string,
    ) {
      this.content = value
    },
  }
  const bootstrap = {
    installation: 'fixture',
    token: 'refreshed',
  }
  const document = Object.assign(
    new EventTarget(),
    {
      visibilityState: 'visible',
      // eslint-disable-next-line pnyx/object-params -- Document owns the query signature.
      querySelector: (selector: string) => selector.includes('pnyx-token') ? token : ({
        content: 'fixture',
        setAttribute() {},
      }),
      // The page's memory line counts the elements.
      getElementsByTagName: () => ({ length: 0 }),
    },
  )
  const globals = {
    document,
    location: new URL('http://pnyx.test/hydra/default/'),
    history: {
      replaceState() {},
      pushState() {},
    },
    sessionStorage,
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    window: events,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    WebSocket: TestSocket,
    // The page's memory line waits for a frame where the browser has no idle callback.
    // eslint-disable-next-line pnyx/object-params -- the browser owns requestAnimationFrame's signature.
    requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(
      () => run(performance.now()),
      0,
    ),
    DOMParser: class {
      parseFromString() {
        return {
          // eslint-disable-next-line pnyx/object-params -- Document owns the query signature.
          querySelector: (selector: string) => ({ content: selector.includes('pnyx-token') ? bootstrap.token : bootstrap.installation }),
        }
      }
    },
    fetch: async () => {
      throw new Error('Network unavailable')
    },
  }

  for (const [
    key,
    value,
  ] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      key,
    )
    Object.defineProperty(
      globalThis,
      key,
      {
        value,
        configurable: true,
      },
    )
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(
          globalThis,
          key,
          descriptor,
        )
      } else {
        Reflect.deleteProperty(
          globalThis,
          key,
        )
      }
    })
  }

  return {
    events,
    document,
    token,
    bootstrap,
  }
}

// Brings a started connection's socket up on the default Hydra.
function open({ socket }: { socket: TestSocket }) {
  socket.onopen?.()
  socket.receive({
    message: {
      type: 'hello',
      installation: 'fixture',
      hydraId: 'fixture',
      subscription: 'fixture',
    },
  })
  socket.receive({
    message: {
      type: 'latest',
      subscription: 'fixture',
      messages: {},
      actions: {},
    },
  })
}

test(
  'offline reports a detected connection loss, independently of Hydra loading or refusal',
  async t => {
    t.after(() => stop())
    installPage({
      t,
      sessionStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
    })
    const connection = createHydraConnection({ watch: hydras.watch })
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    assert.equal(
      connection.snapshot().connected,
      false,
    )
    const stop = connection.start()
    const socket = TestSocket.current
    open({ socket })
    const listing = socket.sent.find(message => message.name === 'hydras')!
    socket.receive({
      message: {
        type: 'receipt',
        id: listing.id,
      },
    })

    await connection.navigate({ url: 'http://pnyx.test/hydra/second/' })
    assert.equal(
      connection.snapshot().connected,
      false,
    )
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )
    const subscription = socket.sent.find(message => message.type === 'subscribe'
      && message.scope === 'second')!.subscription
    socket.receive({
      message: {
        scope: 'second',
        subscription,
        type: 'scope-error',
        code: 'NOT_FOUND',
        error: 'Hydra not found',
      },
    })
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    assert.equal(
      connection.snapshot().recovery?.message,
      'Hydra not found',
    )
    await connection.navigate({ url: 'http://pnyx.test/hydra/default/' })
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )

    socket.onerror?.()
    assert.equal(
      connection.snapshot().offline,
      true,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )
    window.dispatchEvent(new Event('online'))
    const replacement = TestSocket.current
    assert.notEqual(
      replacement,
      socket,
    )
    assert.equal(
      connection.snapshot().offline,
      true,
    )
    replacement.onopen?.()
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    assert.equal(
      connection.snapshot().connected,
      false,
    )
    socket.onclose?.()
    assert.equal(
      connection.snapshot().offline,
      false,
    )
    open({ socket: replacement })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    replacement.onclose?.()
    assert.equal(
      connection.snapshot().offline,
      true,
    )
  },
)

test(
  'resetting every Hydra layout keeps the navigation catalog intact',
  async t => {
    t.after(() => stop())
    installPage({
      t,
      sessionStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
    })

    const connection = createHydraConnection({ watch: hydras.watch })
    const stop = connection.start()
    const socket = TestSocket.current
    open({ socket })
    const catalog = [
      {
        id: 'default',
        name: 'Eos',
        order: 1,
        hydra: 'fixture',
        projects: [],
      },
    ]
    const listing = socket.sent.find(message => message.name === 'hydras')!
    socket.receive({
      message: {
        type: 'receipt',
        id: listing.id,
        hydras: catalog,
      },
    })
    assert.deepEqual(
      connection.snapshot().navigation.hydras,
      catalog,
    )

    const reset = connection.commandFor({ id: 'default' })({
      name: 'layout',
      args: [
        'reset',
        '--all',
      ],
    })
    const request = socket.sent.find(message => message.name === 'layout')!
    const results = [
      {
        hydra: 'default',
        event: 'none: unchanged',
      },
    ]
    socket.receive({
      message: {
        type: 'receipt',
        id: request.id,
        hydras: results,
      },
    })
    assert.deepEqual(
      (await reset).hydras,
      results,
    )
    assert.deepEqual(
      connection.snapshot().navigation.hydras,
      catalog,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )

    const renamed = [
      {
        ...catalog[0],
        name: 'Apollo',
      },
    ]
    socket.receive({
      message: {
        type: 'hydras',
        subscription: 'fixture',
        hydras: renamed,
      },
    })
    assert.deepEqual(
      connection.snapshot().navigation.hydras,
      renamed,
    )
  },
)

test(
  'a Hydra still being created comes back after a reload and opens once the server confirms it',
  async t => {
    const saved = new Map<string, string>()
    const stops: (() => void)[] = []
    t.after(() => stops.forEach(stop => stop()))
    installPage({
      t,
      sessionStorage: {
        // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
        getItem: (key: string) => saved.get(key) ?? null,
        // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
        setItem: (
          key: string,
          value: string,
        ) => {
          saved.set(
            key,
            value,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
        removeItem: (key: string) => {
          saved.delete(key)
        },
      },
    })
    const catalog = [
      {
        id: 'default',
        name: 'Eos',
        order: 1,
        hydra: 'fixture',
        projects: [],
      },
    ]

    const first = createHydraConnection({ watch: hydras.watch })
    stops.push(first.start())
    const firstSocket = TestSocket.current
    open({ socket: firstSocket })
    const listing = firstSocket.sent.find(message => message.name === 'hydras')!
    firstSocket.receive({
      message: {
        type: 'receipt',
        id: listing.id,
        hydras: catalog,
      },
    })
    void first.create({
      name: 'Apollo',
      icon: 'rocket',
    }).catch(() => {})
    // The pending id carries the creation attempt, so the reload must restore that same attempt.
    const pending = first.snapshot().navigation.hydraId
    assert.equal(
      first.snapshot().creating,
      true,
    )
    stops.pop()!()

    const reloaded = createHydraConnection({ watch: hydras.watch })
    stops.push(reloaded.start())
    assert.equal(
      reloaded.snapshot().navigation.hydraId,
      pending,
    )
    assert.equal(
      reloaded.snapshot().creating,
      true,
    )

    const socket = TestSocket.current
    open({ socket })
    const creation = socket.sent.find(message => message.name === 'hydras'
      && (message.args as string[])[0] === 'create')!
    const attempt = (creation.args as string[])[2]!
    const apollo = {
      id: 'apollo',
      name: 'Apollo',
      icon: 'rocket',
      order: 2,
      hydra: 'fixture',
      projects: [],
      creationAttempt: attempt,
    }
    socket.receive({
      message: {
        type: 'receipt',
        id: creation.id,
        creation: {
          hydraId: 'apollo',
          attempt,
          status: 'saved',
          mount: 'pending',
        },
        hydras: [
          ...catalog,
          apollo,
        ],
      },
    })
    assert.equal(
      reloaded.snapshot().navigation.hydraId,
      'apollo',
    )
    assert.equal(
      reloaded.snapshot().creating,
      false,
    )
    assert.deepEqual(
      reloaded.snapshot().navigation.hydras.map(hydra => hydra.id),
      [
        'default',
        'apollo',
      ],
    )
  },
)

function recoveryPage({ t }: { t: TestContext }) {
  const cleanup: { stop?: () => void } = {}
  t.after(() => cleanup.stop?.())
  t.mock.timers.enable({
    apis: [
      'Date',
      'setTimeout',
      'setInterval',
    ],
    now: 100_000,
  })
  const page = installPage({
    t,
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
  })
  const connection = createHydraConnection({ watch: hydras.watch })
  const stop = connection.start()
  cleanup.stop = stop
  open({ socket: TestSocket.current })

  return {
    ...page,
    connection,
    stop,
  }
}

test(
  'server restarts and long outages reconnect without giving up and replace stale state',
  async t => {
    const {
      connection,
      stop,
    } = recoveryPage({ t })
    // What other tests left queued, and this page's first open line, go out before the lines this test reads.
    t.mock.timers.tick(2000)
    const sends = t.mock.method(
      TestSocket.prototype,
      'send',
    )
    const original = TestSocket.current
    hydras.show({
      state: {
        ...emptyHydra(),
        seq: 3,
      },
    })

    for (let outage = 0; outage < 12; outage++) {
      const lost = TestSocket.current
      lost.onclose?.()
      t.mock.timers.tick(10_000)
      await setImmediate()
      assert.notEqual(
        TestSocket.current,
        lost,
      )
    }

    const restored = TestSocket.current
    open({ socket: restored })
    hydras.show({
      state: {
        ...emptyHydra(),
        seq: 8,
      },
    })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    assert.equal(
      connection.snapshot().state.seq,
      8,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )
    original.onerror?.()
    assert.equal(
      TestSocket.current,
      restored,
    )
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    stop()
    t.mock.timers.tick(60_000)
    assert.equal(
      TestSocket.current,
      restored,
    )
    const socketLines = sends.mock.calls.flatMap(call => {
      const sent = JSON.parse(String(call.arguments[0])) as {
        type: string
        lines?: Record<string, unknown>[]
      }

      return sent.type === 'log' ? sent.lines ?? [] : []
    })
      .filter(line => line.operation === 'page.socket')
    assert.deepEqual(
      socketLines.map(line => [
        line.status,
        line.count,
      ]),
      [
        [
          'lost',
          undefined,
        ],
        [
          'failed',
          undefined,
        ],
        [
          'open',
          11,
        ],
      ],
      'an outage logs its loss and its first failed attempt once, and the open after it counts the attempts',
    )
  },
)

test(
  'conversation gaps resync and the memory line counts the retained chat after deltas',
  t => {
    const {
      stop,
      connection,
    } = recoveryPage({ t })
    t.mock.timers.tick(2000)
    const sends = t.mock.method(
      TestSocket.prototype,
      'send',
    )
    const socket = TestSocket.current
    hydras.show({
      state: {
        ...emptyHydra(),
        seq: 1,
      },
    })
    const initial: ThreadPage = {
      card: '$hydra',
      stream: 'memory',
      version: 1,
      entries: [
        {
          id: 'first',
          role: 'You',
          kind: 'message',
          text: 'Hello',
        },
        {
          id: 'second',
          role: 'Hydra',
          kind: 'message',
          text: 'Hi',
        },
      ],
      route: false,
      watching: 'unknown',
    }
    socket.receive({
      message: {
        type: 'thread',
        subscription: 'fixture',
        thread: initial,
      },
    })
    const latest: ThreadPage = {
      ...initial,
      version: 2,
      entries: [
        initial.entries[0]!,
        {
          ...initial.entries[1]!,
          text: 'The longer reply has arrived.',
        },
      ],
    }
    const delta = threadDelta({
      before: initial,
      after: latest,
    })
    assert.ok(delta)
    socket.receive({
      message: {
        type: 'thread.delta',
        subscription: 'fixture',
        delta,
      },
    })
    const held = connection.snapshot().hydraThread
    assert.deepEqual(
      held,
      latest,
    )
    socket.receive({
      message: {
        type: 'thread.delta',
        subscription: 'fixture',
        delta: {
          ...delta,
          base: 3,
          page: {
            ...delta.page,
            version: 4,
          },
        },
      },
    })
    assert.equal(
      connection.snapshot().hydraThread,
      held,
    )
    assert.deepEqual(
      socket.sent.filter(message => message.type === 'resync'),
      [
        {
          type: 'resync',
          scope: 'default',
        },
      ],
    )
    const recovered: ThreadPage = {
      ...latest,
      version: 5,
      entries: [
        ...latest.entries,
        {
          id: 'third',
          role: 'Hydra',
          kind: 'message',
          text: 'After reset',
        },
      ],
    }
    socket.receive({
      message: {
        type: 'thread',
        subscription: 'fixture',
        thread: recovered,
      },
    })
    assert.deepEqual(
      connection.snapshot().hydraThread,
      recovered,
    )
    // A pong on the way keeps the socket from looking stalled.
    t.mock.timers.tick(20_000)
    socket.receive({ message: { type: 'pong' } })
    t.mock.timers.tick(10_000)
    stop()
    const memory = sends.mock.calls.flatMap(call => {
      const sent = JSON.parse(String(call.arguments[0])) as {
        type: string
        lines?: Record<string, unknown>[]
      }

      return sent.type === 'log' ? sent.lines ?? [] : []
    })
      .filter(line => line.operation === 'page.memory')
    assert.deepEqual(
      memory.map(line => [
        line.chatChars,
        line.messages,
        line.elements,
        'heapUsed' in line,
      ]),
      [
        [
          JSON.stringify(recovered).length,
          3,
          0,
          false,
        ],
      ],
      'a browser without a JS heap figure leaves the field out',
    )
  },
)

test(
  'waking a sleeping or restored page replaces an apparently open stale socket immediately',
  t => {
    const {
      connection,
      events,
      document,
    } = recoveryPage({ t })
    const sleeping = TestSocket.current
    document.visibilityState = 'hidden'
    t.mock.timers.setTime(160_000)
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(
      TestSocket.current,
      sleeping,
    )
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    assert.notEqual(
      TestSocket.current,
      sleeping,
    )
    open({ socket: TestSocket.current })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    const restored = TestSocket.current
    t.mock.timers.setTime(220_000)
    events.dispatchEvent(new Event('pageshow'))
    assert.notEqual(
      TestSocket.current,
      restored,
    )
    open({ socket: TestSocket.current })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
  },
)

test(
  'switching Hydras ignores stale subscriptions and recovers stalled loads despite healthy heartbeats',
  async t => {
    const { connection } = recoveryPage({ t })
    const socket = TestSocket.current
    await connection.navigate({ url: 'http://pnyx.test/hydra/second/' })
    const abandoned = socket.sent.find(message => message.type === 'subscribe' && message.scope === 'second')!
    await connection.navigate({ url: 'http://pnyx.test/hydra/default/' })
    await connection.navigate({ url: 'http://pnyx.test/hydra/second/' })
    const first = socket.sent.filter(message => message.type === 'subscribe' && message.scope === 'second').at(-1)!
    assert.notEqual(
      first.subscription,
      abandoned.subscription,
    )
    socket.receive({
      message: {
        type: 'scope-error',
        scope: 'second',
        subscription: abandoned.subscription,
        code: 'NOT_FOUND',
        error: 'Stale refusal',
      },
    })
    assert.equal(
      connection.snapshot().recovery,
      null,
    )
    socket.receive({
      message: {
        type: 'scope-error',
        scope: 'second',
        subscription: first.subscription,
        code: 'LOCKED',
        error: 'Hydra is temporarily locked',
      },
    })
    t.mock.timers.tick(500)
    const retry = socket.sent.filter(message => message.type === 'subscribe' && message.scope === 'second').at(-1)!
    assert.notEqual(
      retry.subscription,
      first.subscription,
    )
    socket.receive({
      message: {
        type: 'latest',
        scope: 'second',
        subscription: first.subscription,
        messages: {},
        actions: {},
      },
    })
    assert.equal(
      connection.snapshot().connected,
      false,
    )
    socket.receive({ message: { type: 'pong' } })
    t.mock.timers.tick(25_000)
    socket.receive({ message: { type: 'pong' } })
    t.mock.timers.tick(1_000)
    const resumed = socket.sent.filter(message => message.type === 'subscribe' && message.scope === 'second').at(-1)!
    assert.notEqual(
      resumed.subscription,
      retry.subscription,
    )
    socket.receive({
      message: {
        type: 'hello',
        scope: 'second',
        subscription: resumed.subscription,
        installation: 'fixture',
        hydraId: 'second',
      },
    })
    socket.receive({
      message: {
        type: 'latest',
        scope: 'second',
        subscription: resumed.subscription,
        messages: {},
        actions: {},
      },
    })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )
  },
)

test(
  'ordinary API errors have no connection recovery action and cannot poison later subscriptions',
  async t => {
    const { connection } = recoveryPage({ t })
    const socket = TestSocket.current
    const search = connection.commandFor({ id: 'default' })({
      name: 'oracle',
      args: ['billing'],
    })
    const cancelled = assert.rejects(
      search,
      { code: 'CANCELLED' },
    )
    const scan = socket.sent.find(message => message.name === 'oracle')!
    socket.receive({
      message: {
        type: 'error',
        id: scan.id,
        code: 'CANCELLED',
        error: 'Oracle search cancelled',
      },
    })
    await cancelled
    assert.equal(
      connection.snapshot().error,
      '',
    )
    const catalog = connection.commandFor({ id: 'default' })({
      name: 'models',
      args: ['codex'],
    })
    const rejected = assert.rejects(
      catalog,
      /Model catalog unavailable/,
    )
    const request = socket.sent.find(message => message.name === 'models')!
    socket.receive({
      message: {
        type: 'error',
        id: request.id,
        code: 'NOT_FOUND',
        error: 'Model catalog unavailable',
      },
    })
    await rejected
    assert.equal(
      connection.snapshot().error,
      'Model catalog unavailable',
    )
    assert.equal(
      connection.snapshot().recovery,
      null,
    )
    await connection.navigate({ url: 'http://pnyx.test/hydra/missing/' })
    const subscription = socket.sent.find(message => message.type === 'subscribe' && message.scope === 'missing')!.subscription
    socket.receive({
      message: {
        type: 'scope-error',
        scope: 'missing',
        subscription,
        code: 'NOT_FOUND',
        error: 'Hydra not found',
      },
    })
    assert.deepEqual(
      connection.snapshot().recovery,
      {
        message: 'Hydra not found',
        action: 'retry',
      },
    )
    assert.equal(
      connection.snapshot().error,
      '',
    )
    connection.retry()
    const retried = socket.sent.filter(message => message.type === 'subscribe' && message.scope === 'missing').at(-1)!
    socket.receive({
      message: {
        type: 'hello',
        scope: 'missing',
        subscription: retried.subscription,
        installation: 'fixture',
        hydraId: 'missing',
      },
    })
    socket.receive({
      message: {
        type: 'latest',
        scope: 'missing',
        subscription: retried.subscription,
        messages: {},
        actions: {},
      },
    })
    assert.equal(
      connection.snapshot().recovery,
      null,
    )
    assert.equal(
      connection.snapshot().connected,
      true,
    )
  },
)

test(
  'missing credentials and installation changes require a reload instead of endless recovery',
  t => {
    const {
      connection,
      token,
      events,
    } = recoveryPage({ t })
    token.content = ''
    const first = TestSocket.current
    first.onclose?.()
    events.dispatchEvent(new Event('online'))
    assert.deepEqual(
      connection.snapshot().recovery,
      {
        message: 'This page has no connection token. Reload to connect.',
        action: 'reload',
      },
    )
    token.content = 'fixture'
    events.dispatchEvent(new Event('online'))
    const replacement = TestSocket.current
    replacement.receive({
      message: {
        type: 'hello',
        installation: 'different',
        hydraId: 'fixture',
        subscription: 'fixture',
      },
    })
    assert.equal(
      connection.snapshot().recovery?.action,
      'reload',
    )
    t.mock.timers.tick(60_000)
    events.dispatchEvent(new Event('online'))
    assert.equal(
      TestSocket.current,
      replacement,
    )
    assert.equal(
      connection.snapshot().connected,
      false,
    )
  },
)

for (const scenario of [
  {
    name: 'missing credentials',
    page: {
      installation: 'fixture',
      token: '',
    },
    message: 'This page has no connection token. Reload to connect.',
  },
  {
    name: 'a changed installation',
    page: {
      installation: 'different',
      token: 'different-token',
    },
    message: 'This address now serves another Pnyx installation. Reload to continue.',
  },
  {
    name: 'missing installation metadata',
    page: {
      installation: '',
      token: 'different-token',
    },
    message: 'This page has no connection token. Reload to connect.',
  },
]) {
  test(
    `rejected handshakes refresh credentials and stop on ${scenario.name}`,
    async t => {
      const {
        connection,
        token,
        bootstrap,
      } = recoveryPage({ t })
      t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('<html></html>'),
      )
      TestSocket.current.onclose?.()
      t.mock.timers.tick(500)
      const rejected = TestSocket.current
      assert.equal(
        rejected.token,
        'fixture',
      )
      rejected.onerror?.()
      t.mock.timers.tick(1_000)
      await setImmediate()
      const refreshed = TestSocket.current
      assert.equal(
        refreshed.token,
        'refreshed',
      )
      assert.equal(
        token.content,
        'refreshed',
      )
      open({ socket: refreshed })
      assert.equal(
        connection.snapshot().connected,
        true,
      )
      Object.assign(
        bootstrap,
        scenario.page,
      )
      refreshed.onclose?.()
      t.mock.timers.tick(500)
      const missing = TestSocket.current
      missing.onerror?.()
      t.mock.timers.tick(1_000)
      await setImmediate()
      assert.deepEqual(
        connection.snapshot().recovery,
        {
          message: scenario.message,
          action: 'reload',
        },
      )
      assert.equal(
        token.content,
        'refreshed',
      )
      t.mock.timers.tick(60_000)
      assert.equal(
        TestSocket.current,
        missing,
      )
    },
  )
}

test(
  'a reconnecting page names the cards it last opened in its socket address',
  async t => {
    t.after(() => stop())
    installPage({
      t,
      sessionStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
    })
    const connection = createHydraConnection({ watch: hydras.watch })
    const stop = connection.start()
    const socket = TestSocket.current
    open({ socket })
    const args = [
      '--card',
      'hidden-task',
    ]
    const request = connection.commandFor({ id: 'default' })({
      name: 'page',
      args,
    })
    // The socket closes before the server answers, so this command's outcome is not under test.
    request.catch(() => {})

    socket.onclose?.()
    window.dispatchEvent(new Event('online'))
    assert.notEqual(
      TestSocket.current,
      socket,
    )
    assert.deepEqual(
      TestSocket.current.page,
      args,
    )
  },
)

test(
  'switching to another Hydra subscribes with the cards that Hydra last opened',
  async t => {
    const { connection } = recoveryPage({ t })
    const socket = TestSocket.current
    const args = [
      '--card',
      'hidden-task',
    ]
    const request = connection.commandFor({ id: 'second' })({
      name: 'page',
      args,
    })
    // The server never answers here; only the subscribe frame is under test.
    request.catch(() => {})
    await connection.navigate({ url: 'http://pnyx.test/hydra/second/' })
    assert.deepEqual(
      socket.sent.filter(message => message.type === 'subscribe' && message.scope === 'second').at(-1)?.page,
      args,
    )
  },
)
