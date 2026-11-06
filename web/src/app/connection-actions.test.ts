import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { createHydraConnection } from './connection-store.ts'

class BrowserSocket {
  static OPEN = 1
  static instances: BrowserSocket[] = []
  readyState = 1
  subscription: string
  sent: {
    id: string
    name: string
  }[] = []

  onmessage?: ({ data }: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  // eslint-disable-next-line pnyx/object-params -- WebSocket owns the constructor signature.
  constructor(url: URL) {
    this.subscription = url.searchParams.get('subscription')!
    BrowserSocket.instances.push(this)
  }

  // eslint-disable-next-line pnyx/object-params -- WebSocket owns the method signature.
  send(data: string) {
    this.sent.push(JSON.parse(data) as {
      id: string
      name: string
    })
  }

  close() {
    this.readyState = 3
  }

  receive({ message }: { message: ServerMessage }) {
    this.onmessage?.({
      data: JSON.stringify({
        ...message,
        scope: 'default',
        subscription: this.subscription,
      }),
    })
  }
}

function browserFixture({ t }: { t: TestContext }) {
  const events = new EventTarget()
  const stored = new Map<string, string>()
  const storage = {
    // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
    getItem: (key: string) => stored.get(key) ?? null,
    // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
    setItem: (
      key: string,
      value: string,
    ) => stored.set(
      key,
      value,
    ),
    // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
    removeItem: (key: string) => stored.delete(key),
    key: () => null,
    length: 0,
  }
  const environment = {
    window: events,
    document: {
      visibilityState: 'visible',
      // eslint-disable-next-line pnyx/object-params -- Document owns the method signature.
      querySelector: (selector: string) => ({
        content: selector.includes('token') ? 'token' : 'test',
        setAttribute() {},
      }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    location: new URL('http://example.test/hydra/default/'),
    history: {
      replaceState() {},
      pushState() {},
    },
    localStorage: storage,
    sessionStorage: storage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    WebSocket: BrowserSocket,
  }
  const cleanup: { stop?: () => void } = {}
  const descriptors = Object.fromEntries(Object.keys(environment).map(key => [
    key,
    Object.getOwnPropertyDescriptor(
      globalThis,
      key,
    ),
  ]))
  t.after(async () => {
    cleanup.stop?.()
    await setImmediate()

    for (const key of Object.keys(environment)) {
      const descriptor = descriptors[key]

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
    }
  })

  for (const [
    key,
    value,
  ] of Object.entries(environment)) {
    Object.defineProperty(
      globalThis,
      key,
      {
        value,
        configurable: true,
        writable: true,
      },
    )
  }

  const connection = createHydraConnection()
  cleanup.stop = connection.start()

  return {
    connection,
    events,
    stored,
    storage,
  }
}

test(
  'disconnect and replacement snapshots discard native activity evidence',
  t => {
    const {
      connection,
      events,
    } = browserFixture({ t })
    const first = BrowserSocket.instances.at(-1)!
    first.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    first.receive({
      message: {
        type: 'snapshot',
        seq: 0,
        state: emptyHydra(),
      },
    })
    first.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {
          task: {
            calls: [
              {
                id: 'tool',
                tool: 'Shell',
              },
            ],
            done: false,
            work: {
              runningTurns: ['turn'],
              runningTools: ['tool'],
              unsettledInputs: [],
              pendingControls: [],
              queue: {
                knowledge: 'known',
                count: 0,
              },
              background: {
                knowledge: 'known',
                tasks: [],
              },
            },
          },
        },
      },
    })
    assert.equal(
      connection.snapshot().actions.task?.calls[0]?.tool,
      'Shell',
    )
    first.onclose?.()
    assert.deepEqual(
      connection.snapshot().actions,
      {},
    )
    assert.equal(
      connection.snapshot().connected,
      false,
    )
    events.dispatchEvent(new Event('online'))
    const replacement = BrowserSocket.instances.at(-1)!
    assert.notEqual(
      replacement,
      first,
    )
    replacement.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    replacement.receive({
      message: {
        type: 'snapshot',
        seq: 0,
        state: emptyHydra(),
      },
    })
    replacement.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {},
      },
    })
    assert.equal(
      connection.snapshot().connected,
      true,
    )
    assert.deepEqual(
      connection.snapshot().actions,
      {},
    )
    // Answering the page's Hydra list leaves no request to reject once the connection stops.
    const listing = replacement.sent.find(message => message.name === 'hydras')!
    replacement.receive({
      message: {
        type: 'receipt',
        id: listing.id,
      },
    })
  },
)

test(
  'live spend and usage survive events and stay out of persisted Hydra state',
  t => {
    const {
      connection,
      stored,
      events,
    } = browserFixture({ t })
    const socket = BrowserSocket.instances.at(-1)!
    socket.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    const event = {
      v: 1 as const,
      id: 'created',
      seq: 1,
      at: '2026-11-06T00:00:00Z',
      actor: 'web',
      cardId: 'task',
      type: 'task.created' as const,
      data: {
        key: 'task',
        title: 'Task',
      },
    }
    const state = reduce({
      state: emptyHydra(),
      event,
    })
    socket.receive({
      message: {
        type: 'snapshot',
        seq: 1,
        state,
      },
    })
    const spend = {
      total: 3,
      unavailable: 0,
      sharedHydra: false,
    }
    const usage = {
      who: {
        provider: 'fixture',
        icon: 'agent',
      },
      recorded: spend,
      windows: [],
    }
    socket.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {},
        spend: { task: spend },
        usage: { task: usage },
      },
    })
    assert.deepEqual(
      connection.snapshot().state.cards.task!.spend,
      spend,
    )
    socket.receive({
      message: {
        type: 'event',
        event: {
          ...event,
          seq: 2,
          id: 'other',
          cardId: 'other',
          data: {
            key: 'other',
            title: 'Other',
          },
        },
      },
    })
    assert.deepEqual(
      connection.snapshot().state.cards.task!.spend,
      spend,
    )
    assert.deepEqual(
      connection.snapshot().state.cards.task!.usage,
      usage,
    )
    events.dispatchEvent(new Event('pagehide'))
    const saved = [...stored.values()].map(value => JSON.parse(value)).filter(value => value?.cards)
    assert.ok(saved.length > 0)

    for (const snapshot of saved) {
      assert.equal(
        snapshot.cards.task.spend,
        undefined,
      )
      assert.equal(
        snapshot.cards.task.usage,
        undefined,
      )
    }

    socket.receive({
      message: {
        type: 'snapshot',
        seq: state.seq,
        state,
      },
    })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
  },
)
