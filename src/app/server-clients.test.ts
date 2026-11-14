import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { closeLogs, flushLogs, logsDir, openLogs } from './diagnostics.ts'
import type { HydraEvent, HydraState } from './model.ts'
import { emptyHydra, reduce } from './reducer.ts'
import { createServerClients } from './server-clients.ts'
import { createHydra } from './server-hydras.ts'
import { loadHydra } from './store.ts'
import { runForRequest } from './api-run.ts'
import { MAX_BUFFERED, SOCKET_RETRY_MS, type HydraClient, type ServerMessage } from './server-transport.ts'
import { usageFor } from '#workers/usage.ts'
import { query } from '#store/postgres.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { LatestMessage } from '#hydra/transcripts-read.ts'

test(
  'latest messages, actions and spend recover after drain without another update and follow what the tab opened',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-client-recovery-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-10T01:20:33Z',
        actor: 'web',
        cardId: '$hydra',
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    state.cards.$hydra!.activity = 'working'
    state.cards.other = {
      ...state.cards.$hydra!,
      id: 'other',
      key: 'other',
      automaticTask: false,
      hidden: false,
    }
    state.cards.removed = {
      ...state.cards.$hydra!,
      id: 'removed',
      key: 'removed',
      automaticTask: false,
      hidden: false,
    }
    state.cards.hidden = {
      ...state.cards.other!,
      id: 'hidden',
      key: 'hidden',
      hidden: true,
      steering: [
        {
          id: 'history',
          order: 1,
          text: 'Private history',
          source: 'fixture',
          at: '2026-11-12T00:00:00Z',
          actor: 'owner',
          attempts: [],
        },
      ],
    }
    state.keys.hidden = 'hidden'
    const action: CurrentAction = {
      calls: [
        {
          id: 'command',
          tool: 'Bash',
          command: 'printf checkpoint',
        },
      ],
      done: false,
    }
    const actions: Record<string, CurrentAction> = { $hydra: action }
    const cachedLatest = {
      hidden: {
        role: 'assistant' as const,
        text: 'Cached hidden reply',
      },
    }
    const cachedUsage = usageFor({
      spend: {
        total: 42,
        unavailable: 0,
        sharedHydra: false,
      },
    })
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => state,
      agents: () => ({
        queue: () => ({
          waiting: [],
          reading: [],
        }),
        usageViews: () => ({ hidden: cachedUsage }),
      }),
      threadSubscriptions: [],
      bindThread() {},
      refreshThread() {},
      feed: () => ({
        latest: cachedLatest,
        actions,
      }),
    })
    t.after(() => tabs.close())
    let buffered = MAX_BUFFERED + 1
    const received: ServerMessage[] = []
    const client: HydraClient = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        received.push(message)
      },
      terminate() {},
    }
    tabs.clients.add(client)
    assert.equal(
      tabs.send({
        ws: client,
        message: {
          type: 'latest',
          messages: {
            $hydra: {
              role: 'assistant',
              text: 'Initial reply',
            },
            other: {
              role: 'assistant',
              text: 'Keep this reply',
            },
            removed: {
              role: 'assistant',
              text: 'Remove this reply',
            },
          },
          actions: {
            $hydra: action,
            other: action,
            removed: action,
          },
        },
      }),
      false,
    )
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          $hydra: {
            role: 'assistant',
            text: 'Newest reply',
          },
          removed: null,
        },
        actions: {
          $hydra: null,
          removed: null,
        },
      },
    })
    assert.equal(
      received.length,
      0,
    )
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    const latest = received.find(message => message.type === 'latest')
    assert.ok(latest?.type === 'latest')
    assert.deepEqual(
      latest.messages,
      {
        $hydra: {
          role: 'assistant',
          text: 'Newest reply',
        },
        other: {
          role: 'assistant',
          text: 'Keep this reply',
        },
        removed: null,
      },
    )
    assert.deepEqual(
      latest.actions,
      {
        $hydra: null,
        other: action,
        removed: null,
      },
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          other: {
            role: 'assistant',
            text: 'Keep the pending reply',
          },
        },
        actions: { other: action },
      },
    })
    buffered = 0
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          $hydra: {
            role: 'assistant',
            text: 'A newer direct reply',
          },
        },
        actions: { $hydra: action },
      },
    })
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.equal(
      received.length,
      1,
    )
    const direct = received[0]
    assert.ok(direct?.type === 'latest')
    assert.deepEqual(
      direct.messages,
      {
        other: {
          role: 'assistant',
          text: 'Keep the pending reply',
        },
        $hydra: {
          role: 'assistant',
          text: 'A newer direct reply',
        },
      },
    )
    assert.deepEqual(
      direct.actions,
      {
        other: action,
        $hydra: action,
      },
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {},
        actions: { removed: action },
      },
    })
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {},
        actions: { removed: null },
      },
    })
    delete actions.$hydra
    const finished = {
      v: 1 as const,
      seq: 2,
      id: 'finished',
      at: '2026-11-10T01:21:28Z',
      actor: 'pnyx',
      cardId: '$hydra',
      type: 'card.pushed' as const,
      data: {
        key: 'hydra',
        activity: 'finished' as const,
      },
    }
    state = reduce({
      state,
      event: finished,
    })
    tabs.broadcast({ event: finished })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.deepEqual(
      received.map(message => message.type),
      ['latest'],
    )
    const cleared = received[0]
    assert.ok(cleared?.type === 'latest')
    assert.equal(
      cleared.actions.removed,
      null,
    )
    const accepted = received.length
    t.mock.timers.tick(SOCKET_RETRY_MS * 2)
    assert.equal(
      received.length,
      accepted,
      'a drained tab gets nothing more until something changes',
    )

    received.length = 0
    tabs.show({
      ws: client,
      interest: {
        cards: ['hidden'],
        hidden: false,
      },
    })
    const opened = received.at(-1)
    assert.ok(opened?.type === 'latest')
    assert.equal(
      opened.messages.hidden?.text,
      'Cached hidden reply',
      'opening a hidden card sends its latest',
    )
    tabs.show({
      ws: client,
      interest: {
        cards: ['hidden'],
        hidden: false,
      },
    })
    assert.equal(
      received.length,
      1,
      'the same interest again sends nothing',
    )
    tabs.show({
      ws: client,
      interest: {
        cards: [],
        hidden: false,
      },
    })
    const released = received.at(-1)
    assert.ok(released?.type === 'latest')
    assert.equal(
      released.messages.hidden,
      undefined,
    )
    buffered = 0
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          absent: {
            role: 'assistant',
            text: 'Stale text',
          },
        },
        actions: { absent: null },
      },
    })
    const scopedLatest = received.at(-1)
    assert.ok(scopedLatest?.type === 'latest')
    assert.equal(
      scopedLatest.messages.absent,
      undefined,
    )
    assert.equal(
      scopedLatest.actions.absent,
      null,
    )
    tabs.show({
      ws: client,
      interest: {
        cards: [],
        hidden: false,
      },
    })
    buffered = 0
    received.length = 0
    const unhide = {
      v: 1 as const,
      id: 'unhide',
      seq: state.seq + 1,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
      cardId: 'hidden',
      type: 'task.visibility' as const,
      data: {
        before: true,
        after: false,
      },
    }
    state = reduce({
      state,
      event: unhide,
    })
    tabs.spendNow.spend = {
      hidden: {
        total: 42,
        unavailable: 0,
        sharedHydra: false,
      },
    }
    tabs.broadcast({ event: unhide })
    const restoredLatest = received.find(message => message.type === 'latest')
    assert.ok(restoredLatest?.type === 'latest')
    assert.equal(
      restoredLatest.messages.hidden?.text,
      'Cached hidden reply',
    )
    assert.equal(
      restoredLatest.spend?.hidden?.total,
      42,
    )
    assert.equal(
      restoredLatest.usage?.hidden?.recorded.tokens,
      42,
    )
  },
)

test(
  'a tab over its socket budget that misses a message it cannot get later is warned about once until it drains',
  t => {
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => emptyHydra(),
      agents: () => ({
        queue: () => ({
          waiting: [],
          reading: [],
        }),
        usageViews: () => ({}),
      }),
      threadSubscriptions: [],
      bindThread() {},
      refreshThread() {},
      feed: () => ({
        latest: {},
        actions: {},
      }),
    })
    t.after(() => tabs.close())
    let buffered = MAX_BUFFERED + 1
    const received: ServerMessage[] = []
    const client: HydraClient = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        received.push(message)
      },
      terminate() {},
    }
    tabs.clients.add(client)
    const pong: ServerMessage = { type: 'pong' }
    const dropped = () => errors.mock.calls
      .map(call => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
      .filter(line => line.operation === 'socket.dropped')

    tabs.send({
      ws: client,
      message: pong,
    })
    tabs.send({
      ws: client,
      message: pong,
    })
    assert.deepEqual(
      dropped().map(line => [
        line.level,
        line.name,
        line.backlog,
      ]),
      [
        [
          'warn',
          'pong',
          MAX_BUFFERED + 1,
        ],
      ],
    )
    buffered = 0
    tabs.send({
      ws: client,
      message: pong,
    })
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: pong,
    })
    assert.equal(
      received.length,
      1,
    )
    assert.equal(
      dropped().length,
      2,
      'a later stretch over the budget is warned about again',
    )
  },
)

test(
  'a tab held over its socket budget has a warning when it starts being held and a line when it drains',
  async t => {
    openLogs()
    t.after(() => closeLogs())
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => emptyHydra(),
      agents: () => ({
        queue: () => ({
          waiting: [],
          reading: [],
        }),
        usageViews: () => ({}),
      }),
      threadSubscriptions: [],
      bindThread() {},
      refreshThread() {},
      feed: () => ({
        latest: {},
        actions: {},
      }),
    })
    t.after(() => tabs.close())
    let buffered = MAX_BUFFERED + 1
    const client: HydraClient = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return buffered
      },
      send() {},
      terminate() {},
    }
    tabs.clients.add(client)
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {},
        actions: {},
      },
    })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await flushLogs()
    const lines = readdirSync(logsDir()).flatMap(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ).split('\n'))
      .filter(Boolean)
      .map(text => JSON.parse(text) as Record<string, unknown>)
      .filter(line => String(line.operation).startsWith('socket.'))
    assert.deepEqual(
      lines.map(line => [
        line.operation,
        line.level,
        line.name ?? line.status,
      ]),
      [
        [
          'socket.held',
          'warn',
          'latest',
        ],
        [
          'socket.drained',
          undefined,
          'drained',
        ],
      ],
    )
  },
)

// One Hydra's tabs over a state the test changes, with one open tab that records every message it receives.
function openTab({
  t,
  state,
  latest = {},
}: {
  t: TestContext
  state(): HydraState
  latest?: Record<string, LatestMessage>
}) {
  const tabs = createServerClients({
    hydraId: 'default',
    state,
    agents: () => ({
      queue: () => ({
        waiting: [],
        reading: [],
      }),
      usageViews: () => ({}),
    }),
    threadSubscriptions: [],
    bindThread() {},
    refreshThread() {},
    feed: () => ({
      latest,
      actions: {},
    }),
  })
  t.after(() => tabs.close())
  const received: ServerMessage[] = []
  const client: HydraClient = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send({ message }) {
      received.push(message)
    },
    terminate() {},
  }
  tabs.clients.add(client)

  return {
    tabs,
    client,
    received,
  }
}

const reduced = ({ events }: { events: HydraEvent[] }) => events.reduce(
  (
    state,
    event,
  ) => reduce({
    state,
    event,
  }),
  emptyHydra(),
)

test(
  'a card another event brings back reaches the page with its last reply',
  t => {
    const base = {
      v: 1 as const,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
    }
    let state = reduced({
      events: [
        {
          ...base,
          id: 'returning',
          seq: 1,
          cardId: 'returning',
          type: 'task.created',
          data: {
            key: 'returning',
            title: 'returning',
            column: 'done',
          },
        },
        {
          ...base,
          id: 'kept',
          seq: 2,
          cardId: 'kept',
          type: 'task.created',
          data: {
            key: 'kept',
            title: 'kept',
            column: 'done',
          },
        },
      ],
    })

    for (const id of [
      'returning',
      'kept',
    ]) {
      state.cards[id]!.hidden = true
      state.cards[id]!.expired = true
    }

    const {
      tabs,
      received,
    } = openTab({
      t,
      state: () => state,
      latest: {
        returning: {
          role: 'assistant',
          text: 'Last reply before hiding',
        },
      },
    })
    const moved: HydraEvent = {
      ...base,
      id: 'moved',
      seq: 3,
      cardId: 'returning',
      type: 'card.moved',
      data: {
        before: 'done',
        after: 'queued',
      },
    }
    state = reduce({
      state,
      event: moved,
    })
    assert.equal(
      state.cards.returning!.hidden,
      undefined,
    )
    tabs.broadcast({ event: moved })
    const latest = received.find(message => message.type === 'latest')
    assert.ok(latest?.type === 'latest')
    assert.equal(
      latest.messages.returning?.text,
      'Last reply before hiding',
    )
  },
)

test(
  'opening a live card sends no latest batch; opening or releasing a hidden one does',
  t => {
    const base = {
      v: 1 as const,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
    }
    const state = reduced({
      events: [
        {
          ...base,
          id: 'live',
          seq: 1,
          cardId: 'live',
          type: 'task.created',
          data: {
            key: 'live',
            title: 'live',
          },
        },
        {
          ...base,
          id: 'gone',
          seq: 2,
          cardId: 'gone',
          type: 'task.created',
          data: {
            key: 'gone',
            title: 'gone',
          },
        },
      ],
    })
    state.cards.gone!.hidden = true
    const {
      tabs,
      client,
      received,
    } = openTab({
      t,
      state: () => state,
    })

    const batches = ({ cards }: { cards: string[] }) => {
      received.length = 0
      tabs.show({
        ws: client,
        interest: {
          cards,
          hidden: false,
        },
      })

      return received.filter(message => message.type === 'latest').length
    }

    assert.equal(
      batches({ cards: ['live'] }),
      0,
    )
    assert.equal(
      batches({
        cards: [
          'live',
          'gone',
        ],
      }),
      1,
    )
    assert.equal(
      batches({ cards: ['gone'] }),
      0,
    )
    assert.equal(
      batches({ cards: [] }),
      1,
    )
  },
)

test(
  'a card created after the tab opened is not a returning card, so it sends no cached latest',
  t => {
    let state = emptyHydra()
    const {
      tabs,
      received,
    } = openTab({
      t,
      state: () => state,
    })
    const created: HydraEvent = {
      v: 1,
      id: 'created',
      seq: 1,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
      cardId: 'fresh',
      type: 'task.created',
      data: {
        key: 'fresh',
        title: 'fresh',
      },
    }
    state = reduce({
      state,
      event: created,
    })
    tabs.broadcast({ event: created })
    assert.equal(
      received.some(message => message.type === 'latest'),
      false,
    )
  },
)

function temporaryHome({ t }: { t: TestContext }) {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-client-queue-',
  ))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return home
}

const WAITING = [
  {
    seq: 3,
    card: 'waiting-task',
  },
]

// The tabs of one Hydra whose host has one update waiting for Hydra.
const queueTabs = ({
  hydraId,
  state,
}: {
  hydraId: string
  state(): HydraState
}) => createServerClients({
  hydraId,
  state,
  agents: () => ({
    queue: () => ({
      waiting: WAITING,
      reading: [],
    }),
    usageViews: () => ({}),
  }),
  threadSubscriptions: [],
  bindThread() {},
  refreshThread() {},
  feed: () => ({
    latest: {},
    actions: {},
  }),
})

const storedQueue = ({ hydraId }: { hydraId: string }) => (query({
  statements: [
    {
      text: 'select value as queue from hydra_queues where hydra_id = $1',
      values: [hydraId],
    },
  ],
})[0] as { queue: unknown }[])[0]?.queue

// What the page reads for a Hydra at `through` with one update waiting and nothing else queued.
const queueBox = ({ through }: { through: number }) => ({
  waiting: [
    {
      seq: 3,
      card: 'waiting-task',
    },
  ],
  reading: [],
  chat: {
    upgrades: [],
    held: [],
    compactOperations: [],
    shownUpgrades: [],
    upgrading: false,
    holding: false,
    runningChange: false,
    compactionRunning: false,
    upgradeRunning: false,
    compactInputs: [],
    working: false,
    through,
    started: [],
  },
})

test(
  'the queue box the page reads through Zero holds the updates waiting for Hydra with the chat queue',
  t => {
    temporaryHome({ t })
    const hydraId = createHydra({ name: 'Queue' })
    const tabs = queueTabs({
      hydraId,
      state: () => loadHydra({ hydraId }).state,
    })

    tabs.storeQueue()
    assert.deepEqual(
      storedQueue({ hydraId }),
      queueBox({ through: 1 }),
    )
  },
)

test(
  'a queue stored before the Hydra has a row is written on the next change once the row exists, without logging a failure',
  async t => {
    const home = temporaryHome({ t })
    openLogs()
    t.after(() => closeLogs())
    const state = emptyHydra()
    const tabs = queueTabs({
      hydraId: 'later',
      state: () => state,
    })

    tabs.storeQueue()
    const created = await runForRequest({
      body: {
        argv: [
          'hydra',
          'create',
          'later',
          '--name',
          'Later',
        ],
        cwd: home,
        env: {},
      },
    })
    assert.equal(
      created.exitCode,
      0,
      created.stdout,
    )
    assert.equal(
      storedQueue({ hydraId: 'later' }),
      undefined,
      'a new Hydra has no queue row until its queue holds something',
    )

    tabs.storeQueue()
    assert.deepEqual(
      storedQueue({ hydraId: 'later' }),
      queueBox({ through: 0 }),
    )
    await flushLogs()
    assert.deepEqual(
      readdirSync(logsDir()).flatMap(name => readFileSync(
        join(
          logsDir(),
          name,
        ),
        'utf8',
      ).split('\n'))
        .filter(Boolean)
        .map(text => JSON.parse(text) as Record<string, unknown>)
        .filter(line => line.operation === 'queue.write'),
      [],
      'a Hydra without its row yet is no failure',
    )
  },
)
