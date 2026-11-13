import { hydraConfig } from '#hydra/config.ts'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { loadUpdates, updatesOf } from '#web-tasks/updates-cache.ts'
import { createHydraConnection } from './connection-store.ts'
import { hydraSource } from '#web-app/fixtures/hydra-source.ts'

const hydras = hydraSource()

class BrowserSocket {
  static OPEN = 1
  static instances: BrowserSocket[] = []
  readyState = 1
  subscription: string
  sent: {
    id: string
    name: string
    args?: string[]
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

test(
  'Later updates shared attention immediately and keeps one return date through reprojection and confirmation',
  async t => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2099-10-16T11:00:00Z'),
    })
    const { connection } = browserFixture({ t })
    const socket = BrowserSocket.instances.at(-1)!
    socket.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    const created: HydraEvent = {
      v: 1,
      seq: 1,
      id: 'created',
      at: '2099-10-16T11:00:00Z',
      actor: 'web',
      cardId: 'task',
      type: 'task.created',
      data: {
        key: 'task',
        title: 'Choose the schema',
      },
    }
    const asked: HydraEvent = {
      v: 1,
      seq: 2,
      id: 'asked',
      at: '2099-10-16T11:00:00Z',
      actor: 'hydra',
      cardId: 'task',
      type: 'task.asked',
      data: {
        id: 'question',
        audience: 'owner',
        question: 'Which schema?',
      },
    }
    const state = reduce({
      state: reduce({
        state: emptyHydra(),
        event: created,
      }),
      event: asked,
    })
    hydras.show({ state })
    socket.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {},
      },
    })
    const result = connection.commandFor({ id: 'default' })({
      name: 'task',
      args: [
        'defer-question',
        'task',
        'question',
        '--until',
        'in 2 hours',
        '--event-id',
        'later-attempt',
      ],
    }).catch(error => error)
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      '2099-10-16T13:00:00.000Z',
    )
    const request = socket.sent.find(message => message.name === 'task')!
    assert.equal(
      request.args?.[4],
      '2099-10-16T13:00:00.000Z',
    )
    t.mock.timers.tick(3 * 60 * 60_000)
    hydras.apply({
      event: {
        ...created,
        seq: 3,
        id: 'other-task',
        cardId: 'other',
        data: {
          key: 'other',
          title: 'Other work',
        },
      },
    })
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      '2099-10-16T13:00:00.000Z',
    )
    socket.receive({
      message: {
        type: 'receipt',
        id: request.id,
        event: {
          id: 'later-attempt',
          seq: 4,
        },
      },
    })
    assert.equal(
      connection.snapshot().intents.find(intent => intent.id === request.id)?.stage,
      'accepted',
    )
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      '2099-10-16T13:00:00.000Z',
    )
    hydras.apply({
      event: {
        v: 1,
        seq: 4,
        id: 'later-attempt',
        at: '2099-10-16T11:00:00Z',
        actor: 'web',
        cardId: 'task',
        type: 'task.ask.deferred',
        data: {
          ask: 'question',
          until: '2099-10-16T13:00:00.000Z',
        },
      },
    })
    socket.receive({
      message: {
        type: 'receipt',
        id: request.id,
      },
    })
    assert.equal(
      connection.snapshot().intents.find(intent => intent.id === request.id)?.stage,
      'confirmed',
    )
    assert.deepEqual(
      connection.snapshot().state.eventIds,
      {},
    )
    const outcome = await result
    assert.ok(!(outcome instanceof Error))
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      '2099-10-16T13:00:00.000Z',
    )
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.answered,
      undefined,
    )
    const clear = connection.commandFor({ id: 'default' })({
      name: 'task',
      args: [
        'defer-question',
        'task',
        'question',
        '--until',
        'clear',
        '--event-id',
        'clear-attempt',
      ],
    }).catch(error => error)
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      undefined,
    )
    const clearRequest = socket.sent.find(message => message.args?.includes('clear-attempt'))!
    hydras.apply({
      event: {
        ...created,
        seq: 5,
        id: 'another-task',
        cardId: 'another',
        data: {
          key: 'another',
          title: 'Another update',
        },
      },
    })
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      undefined,
    )
    hydras.apply({
      event: {
        v: 1,
        seq: 6,
        id: 'clear-attempt',
        at: '2099-10-16T14:00:00Z',
        actor: 'web',
        cardId: 'task',
        type: 'task.ask.deferred',
        data: {
          ask: 'question',
          until: null,
        },
      },
    })
    socket.receive({
      message: {
        type: 'receipt',
        id: clearRequest.id,
        stateSeq: 6,
      },
    })
    assert.ok(!((await clear) instanceof Error))
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.deferredUntil,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task?.asks?.[0]?.answered,
      undefined,
    )
    const agentSave = connection.commandFor({ id: 'default' })({
      name: 'hydra-agent',
      args: [
        JSON.stringify({
          harness: 'claude',
          model: 'next-model',
        }),
      ],
    })
    const agentRequest = socket.sent.find(message => message.name === 'hydra-agent')!
    socket.receive({
      message: {
        type: 'receipt',
        id: agentRequest.id,
        saved: true,
        stateSeq: 7,
      },
    })
    assert.equal(
      connection.snapshot().state.config?.hydra.agent?.model,
      'next-model',
    )
    assert.equal(
      connection.snapshot().intents.find(intent => intent.id === agentRequest.id)?.stage,
      'accepted',
    )
    hydras.show({
      state: {
        ...connection.snapshot().state,
        seq: 7,
      },
    })
    await agentSave
    assert.equal(
      connection.snapshot().state.config?.hydra.agent?.model,
      'next-model',
    )
    assert.equal(
      connection.snapshot().intents.find(intent => intent.id === agentRequest.id)?.stage,
      'confirmed',
    )
  },
)

test(
  'activity from a hidden origin card leaves the task\'s Updates current, and an event its Updates list shows marks it stale',
  async t => {
    const { connection } = browserFixture({ t })
    const socket = BrowserSocket.instances.at(-1)!
    socket.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'created',
        at: '2099-10-16T11:00:00Z',
        actor: 'web',
        cardId: 'task',
        type: 'task.created',
        data: {
          key: 'task',
          title: 'Choose the schema',
        },
      },
    })
    hydras.show({ state })
    socket.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {},
      },
    })
    const readTask = loadUpdates({
      command: connection.commandFor({ id: 'default' }),
      id: 'task',
    })
    socket.receive({
      message: {
        type: 'receipt',
        id: socket.sent.at(-1)!.id,
        events: [],
      },
    })
    await readTask
    const readOther = loadUpdates({
      command: connection.commandFor({ id: 'default' }),
      id: 'unaffected',
    })
    socket.receive({
      message: {
        type: 'receipt',
        id: socket.sent.at(-1)!.id,
        events: [],
      },
    })
    await readOther
    assert.equal(
      updatesOf({ id: 'task' }).stale,
      false,
    )
    socket.receive({
      message: {
        type: 'page.event',
        update: {
          seq: 2,
          cards: {
            origin: null,
            task: {
              ...connection.snapshot().state.cards.task!,
              revision: 2,
            },
          },
        },
      },
    })
    assert.equal(
      updatesOf({ id: 'task' }).stale,
      false,
    )
    hydras.apply({
      event: {
        v: 1,
        id: 'outcome',
        seq: 3,
        at: '2099-10-16T15:00:00Z',
        actor: 'owner',
        cardId: 'task',
        type: 'card.outcome',
        data: {
          before: null,
          after: {
            state: 'done',
            source: 'owner',
            note: 'Shipped',
          },
          card: {
            title: 'Task',
            workspace: '',
            tags: [],
            links: [],
          },
        },
      },
    })
    assert.equal(
      updatesOf({ id: 'task' }).stale,
      true,
    )
    assert.equal(
      updatesOf({ id: 'unaffected' }).stale,
      false,
    )
  },
)

function browserFixture({
  t,
  cached = {},
  origin = `http://${crypto.randomUUID()}.test`,
}: {
  t: TestContext
  cached?: Record<string, string>
  origin?: string
}) {
  const events = new EventTarget()
  const stored = new Map(Object.entries(cached))
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
    location: new URL(
      '/hydra/default/',
      origin,
    ),
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

  const connection = createHydraConnection({ watch: hydras.watch })
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
    hydras.show({ state: emptyHydra() })
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
    hydras.show({ state: emptyHydra() })
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
  'a change keeps untouched cards, messages and the previous state, and live spend and usage survive it',
  t => {
    const { connection } = browserFixture({ t })
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
    state.config = hydraConfig({ state })
    state.cards.task!.agent = {
      provider: 'claude-code',
      sessionId: 'current',
    }
    state.cards.task!.asks = [
      {
        id: 'go',
        at: event.at,
        actor: 'hydra',
        audience: 'owner',
        kind: 'go',
        question: 'Proceed?',
        answered: 'answer',
        choice: 'Go',
        hold: {
          id: 'hold',
          at: event.at,
          actor: 'owner',
          reason: 'Review first',
        },
      },
      {
        id: 'sibling',
        at: event.at,
        actor: 'hydra',
        audience: 'owner',
        question: 'Another question?',
      },
    ]
    state.hydraMessages = [
      {
        id: 'earlier-message',
        action: 'send',
        text: 'Keep this message',
        at: event.at,
        actor: 'owner',
        hydra: 'default',
      },
    ]
    hydras.show({ state })
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
    const readings = {
      type: 'latest' as const,
      messages: {},
      actions: {},
      spend: { task: spend },
      usage: { task: usage },
    }
    socket.receive({
      message: readings,
    })
    assert.deepEqual(
      connection.snapshot().state.cards.task!.spend,
      spend,
    )
    const beforeEvent = connection.snapshot().state
    const previousValue = structuredClone(beforeEvent)
    hydras.apply({
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
    })
    assert.deepEqual(
      connection.snapshot().state.cards.task!.spend,
      spend,
    )
    assert.deepEqual(
      connection.snapshot().state.cards.task!.usage,
      usage,
    )
    assert.equal(
      connection.snapshot().state.cards.task,
      beforeEvent.cards.task,
      'an unrelated event retains a card with live readings',
    )
    assert.equal(
      connection.snapshot().state.hydraMessages,
      beforeEvent.hydraMessages,
    )
    assert.equal(
      connection.snapshot().state.hydraMessages?.[0],
      beforeEvent.hydraMessages?.[0],
    )
    assert.deepEqual(
      beforeEvent,
      previousValue,
      'applying an event leaves the previous snapshot unchanged',
    )
    const other = connection.snapshot().state.cards.other
    socket.receive({
      message: {
        type: 'latest',
        messages: {},
        actions: {},
        spend: {
          task: {
            ...spend,
            total: 4,
          },
        },
      },
    })
    assert.equal(
      connection.snapshot().state.cards.task!.spend?.total,
      4,
    )
    assert.equal(
      connection.snapshot().state.cards.other,
      other,
      'a card without live totals keeps its identity',
    )
    const beforeMessage = connection.snapshot().state
    const messageEvent: HydraEvent = {
      ...event,
      id: 'next-message',
      seq: 3,
      cardId: '$hydra',
      type: 'hydra.message',
      data: {
        action: 'send',
        text: 'A new message',
        hydra: 'default',
      },
    }
    hydras.apply({
      event: messageEvent,
    })
    const afterMessage = connection.snapshot().state
    assert.equal(
      afterMessage.cards,
      beforeMessage.cards,
      'a chat append retains all card views',
    )
    assert.equal(
      afterMessage.hydraMessages?.[0],
      beforeMessage.hydraMessages?.[0],
    )
    assert.notEqual(
      afterMessage.hydraMessages,
      beforeMessage.hydraMessages,
    )
    assert.equal(
      afterMessage.hydraMessages?.[1]?.text,
      'A new message',
    )
    assert.equal(
      beforeMessage.hydraMessages?.length,
      1,
    )
    assert.doesNotThrow(() => structuredClone(afterMessage))
    hydras.apply({
      event: messageEvent,
    })
    assert.equal(
      connection.snapshot().state,
      afterMessage,
      'a duplicate event keeps the entire view',
    )
    const beforeReopen = connection.snapshot().state
    hydras.apply({
      event: {
        ...event,
        id: 'reopened',
        seq: 4,
        type: 'task.ask.reopened',
        data: {
          ask: 'go',
          answer: 'answer',
        },
      },
    })
    const reopened = connection.snapshot().state.cards.task!
    assert.deepEqual(
      reopened.hold,
      {
        id: 'hold',
        at: event.at,
        actor: 'owner',
        reason: 'Review first',
      },
    )
    assert.notEqual(
      reopened.hold,
      beforeReopen.cards.task!.asks?.[0]?.hold,
    )
    assert.equal(
      reopened.asks?.[0]?.answered,
      undefined,
    )
    assert.equal(
      reopened.asks?.[0]?.choice,
      undefined,
    )
    assert.equal(
      reopened.asks?.[1],
      beforeReopen.cards.task!.asks?.[1],
    )
    assert.equal(
      beforeReopen.cards.task!.asks?.[0]?.answered,
      'answer',
    )
    assert.equal(
      beforeReopen.cards.task!.hold,
      undefined,
    )
    const beforeConfig = connection.snapshot().state
    const previousConfig = structuredClone(beforeConfig.config)
    hydras.apply({
      event: {
        ...event,
        id: 'agents',
        seq: 5,
        type: 'board.agents',
        data: {
          agents: { builder: { harness: 'codex' } },
          before: {},
        },
      },
    })
    const configured = connection.snapshot().state
    assert.deepEqual(
      configured.config?.agents,
      { builder: { harness: 'codex' } },
    )
    assert.deepEqual(
      beforeConfig.config,
      previousConfig,
    )
    assert.notEqual(
      configured.config,
      beforeConfig.config,
    )
    assert.equal(
      configured.cards.task,
      beforeConfig.cards.task,
    )
    assert.doesNotThrow(() => structuredClone(configured))
    hydras.show({ state })
    assert.equal(
      connection.snapshot().state.cards.task!.spend?.total,
      4,
    )
    assert.deepEqual(
      connection.snapshot().state.cards.task!.usage,
      usage,
    )
    const replacementEvent = {
      ...event,
      id: 'replacement',
      seq: 2,
      type: 'card.pushed' as const,
      data: {
        key: 'task',
        agent: {
          provider: 'claude-code',
          sessionId: 'replacement',
        },
      },
    }
    hydras.apply({
      event: replacementEvent,
    })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task!.usage,
      undefined,
    )
    const replacement = reduce({
      state,
      event: replacementEvent,
    })
    hydras.show({ state: replacement })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task!.usage,
      undefined,
    )
    socket.receive({ message: readings })
    const nextSession = structuredClone(replacement)
    nextSession.cards.task!.agent!.sessionId = 'next-session'
    hydras.show({ state: nextSession })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task!.usage,
      undefined,
    )
    socket.receive({ message: readings })
    const nextProvider = structuredClone(nextSession)
    nextProvider.cards.task!.agent!.provider = 'codex'
    hydras.show({ state: nextProvider })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task!.usage,
      undefined,
    )
    socket.receive({ message: readings })
    const nextAgent = structuredClone(nextProvider)
    nextAgent.cards.task!.agent!.agentId = 'child'
    hydras.show({ state: nextAgent })
    assert.equal(
      connection.snapshot().state.cards.task!.spend,
      undefined,
    )
    assert.equal(
      connection.snapshot().state.cards.task!.usage,
      undefined,
    )
  },
)

test(
  'Hydra\'s queue stays shown while a snapshot replaces the state',
  t => {
    const { connection } = browserFixture({ t })
    const socket = BrowserSocket.instances.at(-1)!
    socket.receive({
      message: {
        type: 'hello',
        build: 'test',
        hydraId: 'default',
        installation: 'test',
      },
    })
    const queue = {
      waiting: [
        {
          seq: 1,
          card: 'task',
        },
      ],
      reading: [],
    }
    socket.receive({
      message: {
        type: 'hydraQueue',
        queue,
      },
    })
    hydras.show({ state: emptyHydra() })
    assert.deepEqual(
      connection.snapshot().hydraQueue,
      queue,
    )
  },
)

for (const when of [
  '2099-10-16T12:00:00Z',
  'in 2 hours',
]) {
  test(
    `a pending reminder keeps its normalized time after reprojection: ${when}`,
    async t => {
      t.mock.timers.enable({
        apis: ['Date'],
        now: new Date('2099-10-16T11:00:00Z'),
      })
      const { connection } = browserFixture({ t })
      const socket = BrowserSocket.instances.at(-1)!
      socket.receive({
        message: {
          type: 'hello',
          build: 'test',
          hydraId: 'default',
          installation: 'test',
        },
      })
      const created = {
        v: 1 as const,
        seq: 1,
        id: 'created',
        at: '2099-10-16T11:00:00Z',
        actor: 'web',
        cardId: 'task',
        type: 'task.created' as const,
        data: {
          key: 'task',
          title: 'Review cursor examples',
        },
      }
      const state = reduce({
        state: emptyHydra(),
        event: created,
      })
      hydras.show({ state })
      socket.receive({
        message: {
          type: 'latest',
          messages: {},
          actions: {},
        },
      })
      const command = connection.commandFor({ id: 'default' })
      await assert.rejects(
        command({
          name: 'task',
          args: [
            'remind',
            'task',
            '2099-10-16T10:00:00Z',
          ],
        }),
        /future reminder/,
      )
      const result = command({
        name: 'task',
        args: [
          'remind',
          'task',
          when,
        ],
      }).catch(error => error)
      const request = socket.sent.find(message => message.name === 'task')!
      assert.ok(request)
      const expected = when === 'in 2 hours' ? '2099-10-16T13:00:00.000Z' : '2099-10-16T12:00:00.000Z'
      assert.equal(
        connection.snapshot().state.cards.task?.reminder?.at,
        expected,
      )
      assert.equal(
        request.args?.[2],
        expected,
      )
      t.mock.timers.tick(3 * 60 * 60_000)
      hydras.apply({
        event: {
          ...created,
          id: 'other',
          seq: 2,
          cardId: 'other',
          data: {
            key: 'other',
            title: 'Other work',
          },
        },
      })
      assert.equal(
        connection.snapshot().state.cards.task?.reminder?.at,
        expected,
      )
      assert.notEqual(
        connection.snapshot().edits.find(edit => edit.id === request.id)?.stage,
        'refused',
      )
      socket.receive({
        message: {
          type: 'receipt',
          id: request.id,
        },
      })
      const outcome = await result

      if (outcome instanceof Error) {
        throw outcome
      }
    },
  )
}
