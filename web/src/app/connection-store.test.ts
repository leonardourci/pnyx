import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test(
  'resetting every Hydra layout keeps the navigation catalog intact',
  async t => {
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
      sessionStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
      window: events,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      WebSocket: TestSocket,
    }

    t.after(() => stop())

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

    const connection = createHydraConnection()
    const stop = connection.start()
    const socket = TestSocket.current
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
