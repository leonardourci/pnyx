import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeLogs, logsDir, openLogs } from './diagnostics.ts'
import type { HydraEvent } from './model.ts'
import { emptyHydra, reduce } from './reducer.ts'
import { createServerClients } from './server-clients.ts'
import { createHydra } from './server-hydras.ts'
import { MAX_BUFFERED, SOCKET_RETRY_MS, type HydraClient, type ServerMessage } from './server-transport.ts'
import { usageFor } from '#workers/usage.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { CurrentAction } from '#hydra/calls.ts'

test(
  'state, working status, actions and Hydra lists recover after drain without another update',
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
      recent: () => [],
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

        if (message.type === 'snapshot') {
          buffered = MAX_BUFFERED + 1
        }
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
    tabs.sendQueue({ ws: client })
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
    const running = received.find(message => message.type === 'hydraQueue')
    assert.ok(running?.type === 'hydraQueue')
    assert.equal(
      running.queue.chat!.working,
      true,
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
      [
        'snapshot',
        'latest',
        'hydraQueue',
      ],
    )
    const snapshot = received.find(message => message.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot')
    assert.equal(
      snapshot.state.cards.$hydra!.activity,
      'finished',
    )
    assert.equal(
      snapshot.seq,
      2,
    )
    const stopped = received.find(message => message.type === 'hydraQueue')
    assert.ok(stopped?.type === 'hydraQueue')
    assert.equal(
      stopped.queue.chat!.working,
      false,
    )
    const cleared = received.find(message => message.type === 'latest')
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
      'one oversized snapshot must not cause a resync loop',
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.hydraSubscribers.add(client)
    assert.equal(
      tabs.send({
        ws: client,
        message: {
          type: 'hydras',
          hydraId: 'default',
          hydras: [],
        },
      }),
      false,
    )
    const added = createHydra({ name: 'Fresh list' })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.deepEqual(
      received.map(message => message.type),
      [
        'snapshot',
        'latest',
        'hydraQueue',
        'hydras',
      ],
      'a rejected Hydra list must recover without another update',
    )
    const list = received.find(message => message.type === 'hydras')
    assert.ok(list?.type === 'hydras')
    assert.deepEqual(
      list.hydras.map(({
        id,
        name,
      }) => ({
        id,
        name,
      })),
      [
        {
          id: added,
          name: 'Fresh list',
        },
      ],
      'recovery must read the current list instead of sending the stale payload',
    )
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
    buffered = 0
    tabs.show({
      ws: client,
      interest: {
        cards: ['hidden'],
        hidden: false,
      },
    })
    const opened = received.findLast(message => message.type === 'snapshot')
    assert.ok(opened?.type === 'snapshot')
    assert.equal(
      opened.state.cards.hidden?.title,
      state.cards.hidden.title,
    )
    assert.equal(
      opened.state.cards.hidden?.steering,
      undefined,
    )
    assert.equal(
      'eventIds' in opened.state,
      false,
    )
    buffered = 0
    tabs.show({
      ws: client,
      interest: {
        cards: [],
        hidden: false,
      },
    })
    const closed = received.findLast(message => message.type === 'snapshot')
    assert.ok(closed?.type === 'snapshot')
    assert.equal(
      closed.state.cards.hidden,
      undefined,
    )
    buffered = 0
    tabs.show({
      ws: client,
      interest: {
        cards: [],
        hidden: true,
      },
    })
    const all = received.findLast(message => message.type === 'snapshot')
    assert.ok(all?.type === 'snapshot')
    assert.ok(all.state.cards.hidden)
    assert.equal(
      state.cards.hidden.steering?.[0]?.text,
      'Private history',
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
      recent: () => [],
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
    const settings: ServerMessage = {
      type: 'settings',
      settings: {} as Extract<ServerMessage, { type: 'settings' }>['settings'],
      revision: 1,
    }
    const dropped = () => errors.mock.calls
      .map(call => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
      .filter(line => line.operation === 'socket.dropped')

    tabs.send({
      ws: client,
      message: settings,
    })
    tabs.send({
      ws: client,
      message: settings,
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
          'settings',
          MAX_BUFFERED + 1,
        ],
      ],
    )
    buffered = 0
    tabs.send({
      ws: client,
      message: settings,
    })
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: settings,
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
  t => {
    openLogs()
    t.after(() => closeLogs())
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => emptyHydra(),
      recent: () => [],
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
        type: 'hydraQueue',
        queue: {
          waiting: [],
          reading: [],
        },
      },
    })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
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
          'hydraQueue',
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

test(
  'a card another event brings back reaches the page with its last reply, and a column change sends a snapshot',
  t => {
    const base = {
      v: 1 as const,
      at: '2026-11-12T00:00:00Z',
      actor: 'owner',
    }
    let state = emptyHydra()

    for (const [
      seq,
      id,
    ] of [
        'returning',
        'kept',
      ].entries()) {
      state = reduce({
        state,
        event: {
          ...base,
          id,
          seq: seq + 1,
          cardId: id,
          type: 'task.created',
          data: {
            key: id,
            title: id,
            column: 'done',
          },
        },
      })
      state.cards[id]!.hidden = true
      state.cards[id]!.expired = true
    }

    const recent: HydraEvent[] = []
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => state,
      recent: () => recent,
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
        latest: {
          returning: {
            role: 'assistant',
            text: 'Last reply before hiding',
          },
        },
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
    recent.push(moved)
    tabs.broadcast({ event: moved })
    const update = received.find(message => message.type === 'page.event')
    assert.ok(update?.type === 'page.event')
    assert.ok(update.update.cards.returning)
    const latest = received.find(message => message.type === 'latest')
    assert.ok(latest?.type === 'latest')
    assert.equal(
      latest.messages.returning?.text,
      'Last reply before hiding',
    )
    received.length = 0
    const columns: HydraEvent = {
      ...base,
      id: 'columns',
      seq: 4,
      cardId: '$board',
      type: 'board.columns',
      data: {
        columns: hydraConfig({ state }).columns.map(column => ({
          ...column,
          role: undefined,
        })),
      },
    }
    state = reduce({
      state,
      event: columns,
    })
    assert.equal(
      state.cards.kept!.hidden,
      undefined,
    )
    recent.push(columns)
    tabs.broadcast({ event: columns })
    const snapshot = received.find(message => message.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot')
    assert.ok(snapshot.state.cards.kept)
    assert.equal(
      received.some(message => message.type === 'page.event'),
      false,
    )
    received.length = 0
    tabs.resume({
      ws: client,
      after: String(moved.seq),
    })
    assert.equal(
      received[0]?.type,
      'snapshot',
      'a resume across a column change starts from a snapshot',
    )
  },
)

test(
  'opening a live card sends no snapshot; opening or releasing a hidden one does',
  t => {
    let state = emptyHydra()

    for (const [
      seq,
      id,
    ] of [
        'live',
        'gone',
      ].entries()) {
      state = reduce({
        state,
        event: {
          v: 1,
          id,
          seq: seq + 1,
          at: '2026-11-12T00:00:00Z',
          actor: 'owner',
          cardId: id,
          type: 'task.created',
          data: {
            key: id,
            title: id,
          },
        },
      })
    }

    state.cards.gone!.hidden = true
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => state,
      recent: () => [],
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

    const snapshots = ({ cards }: { cards: string[] }) => {
      received.length = 0
      tabs.show({
        ws: client,
        interest: {
          cards,
          hidden: false,
        },
      })

      return received.filter(message => message.type === 'snapshot').length
    }

    assert.equal(
      snapshots({ cards: ['live'] }),
      0,
    )
    assert.equal(
      snapshots({
        cards: [
          'live',
          'gone',
        ],
      }),
      1,
    )
    assert.equal(
      snapshots({ cards: ['gone'] }),
      0,
    )
    assert.equal(
      snapshots({ cards: [] }),
      1,
    )
  },
)
