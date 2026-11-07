import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createHydraConnection } from './connection-store.ts'

class TestSocket {
  static OPEN = 1
  static current: TestSocket
  readyState = 1
  // eslint-disable-next-line pnyx/object-params -- WebSocket callback contract.
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  sent: Record<string, unknown>[] = []

  constructor() {
    TestSocket.current = this
  }

  // eslint-disable-next-line pnyx/object-params -- WebSocket send contract.
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }

  close() {}

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
  const document = Object.assign(
    new EventTarget(),
    {
      querySelector: () => ({
        content: 'fixture',
        setAttribute() {},
      }),
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
}

// Brings a started connection's socket up on the default Hydra.
function open({ socket }: { socket: TestSocket }) {
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

    const connection = createHydraConnection()
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

    const first = createHydraConnection()
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

    const reloaded = createHydraConnection()
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
