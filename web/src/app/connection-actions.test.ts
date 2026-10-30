import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { createHydraConnection } from './connection-store.ts'

class BrowserSocket {
  static OPEN = 1
  static instances: BrowserSocket[] = []
  readyState = 1
  subscription: string
  onmessage?: ({ data }: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  // eslint-disable-next-line pnyx/object-params -- WebSocket owns the constructor signature.
  constructor(url: URL) {
    this.subscription = url.searchParams.get('subscription')!
    BrowserSocket.instances.push(this)
  }

  send() {}
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

test(
  'disconnect and replacement snapshots discard native activity evidence',
  t => {
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
    t.after(() => {
      cleanup.stop?.()

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
  },
)
