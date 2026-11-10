import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { LATEST_DELAY_MS } from './latest-feed.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'
import { emptyHydra, reduce } from './reducer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { createThreadSubscriptions, type Subscription } from './thread-subscriptions.ts'
import { createServerClients } from './server-clients.ts'
import { MAX_BUFFERED } from './server-transport.ts'
import { SOCKET_RETRY_MS } from './server-transport.ts'
import { threadCommand } from '#app/server-commands/thread.ts'
import { mountOwnedHydra } from './server.ts'
import { hydraDir } from './home-migration.ts'
import { writeSnapshot } from './snapshot.ts'

test(
  'a rejected final conversation is delivered after drain without another content change',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-rejected-thread-',
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
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-09T00:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    let buffered = MAX_BUFFERED + 1
    let readyState = 1
    const received: ServerMessage[] = []
    const client: HydraClient = {
      OPEN: 1,
      get readyState() {
        return readyState
      },
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        received.push(message)
      },
      terminate() {},
    }
    let latest: ThreadPage = {
      card: HYDRA_CARD,
      session: 'fixture',
      route: true,
      watching: 'unknown',
      entries: [
        {
          id: 'answer',
          kind: 'message',
          role: 'assistant',
          text: 'The complete final answer.',
          final: true,
        },
      ],
    }
    const sub: Subscription = {
      card: HYDRA_CARD,
      client,
      native: Promise.resolve({
        read: async () => latest,
        close() {},
      }),
    }
    const threads: ReturnType<typeof createThreadSubscriptions> = createThreadSubscriptions({
      hydraId: 'default',
      state: () => state,
      homes: () => [],
      closed: () => false,
      send: ({
        ws,
        message,
      }) => tabs.send({
        ws,
        message,
      }),
      agents: () => ({ thread: ({ page }) => page }),
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
        usageViews: () => ({}),
      }),
      threadSubscriptions: threads.threadSubscriptions,
      bindThread: threads.bindThread,
      refreshThread: threads.refreshThread,
      feed: () => ({
        latest: {},
        actions: {},
      }),
    })
    t.after(() => threads.threadDelivery.close())
    threads.subscriptionMap({ card: HYDRA_CARD }).set(
      client,
      sub,
    )
    const read = ({ id }: { id: string }) => threadCommand({
      ws: client,
      id,
      args: [HYDRA_CARD],
      fail: ({ error }) => assert.fail(error),
      send: tabs.send,
      state: () => state,
      subscriptionMap: threads.subscriptionMap,
      bindThread: threads.bindThread,
      threadPage: threads.threadPage,
    })
    read({ id: 'first-read' })
    read({ id: 'second-read' })
    await setImmediate()
    assert.equal(
      received.length,
      0,
    )
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'The newest read answer.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    const receipts = received.filter(message => message.type === 'receipt')
    assert.deepEqual(
      receipts.map(message => message.id),
      [
        'first-read',
        'second-read',
      ],
    )
    assert.deepEqual(
      receipts.map(message => (message.thread as ThreadPage).conversation!.entries[0]!.text),
      [
        'The newest read answer.',
        'The newest read answer.',
      ],
    )
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.equal(
      received.length,
      2,
      'an unchanged accepted page must not be pushed again',
    )
    received.length = 0
    buffered = MAX_BUFFERED + 1
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'A temporary read answer.',
        },
      ],
    }
    read({ id: 'return-to-accepted' })
    await setImmediate()
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'The newest read answer.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    const returning = received[0]
    assert.ok(returning?.type === 'receipt')
    assert.equal(
      returning.id,
      'return-to-accepted',
    )
    assert.equal(
      (returning.thread as ThreadPage).conversation!.entries[0]!.text,
      'The newest read answer.',
    )
    received.length = 0
    buffered = MAX_BUFFERED + 1
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'The complete final answer.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.equal(
      received.length,
      0,
    )
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.deepEqual(
      received.filter(message => message.type === 'thread')
        .flatMap(message => message.thread.conversation!.entries.map(entry => entry.text)),
      ['The complete final answer.'],
    )
    buffered = MAX_BUFFERED + 1
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'An intermediate answer.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'The newest answer.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    await threads.threadPage({
      sub,
      card: state.cards[HYDRA_CARD]!,
    })
    buffered = 0
    tabs.sendSnapshot({ ws: client })
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.deepEqual(
      received.filter(message => message.type === 'thread')
        .flatMap(message => message.thread.conversation!.entries.map(entry => entry.text)),
      [
        'The complete final answer.',
        'The newest answer.',
      ],
    )
    buffered = MAX_BUFFERED + 1
    latest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'A reply after reconnect.',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    readyState = 3
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.equal(
      received.filter(message => message.type === 'thread').length,
      2,
    )
    readyState = 1
    const reconnected: Subscription = {
      ...sub,
      history: undefined,
      sent: undefined,
      view: undefined,
    }
    threads.subscriptionMap({ card: HYDRA_CARD }).set(
      client,
      reconnected,
    )
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    const delivered = received.filter(message => message.type === 'thread')
    assert.equal(
      delivered.at(-1)!.thread.conversation!.entries[0]!.text,
      'A reply after reconnect.',
    )
    assert.notEqual(
      delivered.at(-1)!.thread.conversation!.stream,
      delivered[0]!.thread.conversation!.stream,
    )
    received.length = 0
    buffered = MAX_BUFFERED + 1
    read({ id: 'queued-before-rebind' })
    read({ id: 'also-queued-before-rebind' })
    await setImmediate()
    threads.bindThread({
      ws: client,
      card: state.cards[HYDRA_CARD]!,
    })
    assert.equal(
      received.length,
      0,
    )
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.deepEqual(
      received.map(message => message.type === 'error' && [
        message.id,
        message.code,
      ]),
      [
        [
          'queued-before-rebind',
          'THREAD_CANCELLED',
        ],
        [
          'also-queued-before-rebind',
          'THREAD_CANCELLED',
        ],
      ],
    )
    received.length = 0
    buffered = MAX_BUFFERED + 1
    const delayed = deferred<ThreadPage>()
    threads.subscriptionMap({ card: HYDRA_CARD }).set(
      client,
      {
        ...reconnected,
        native: Promise.resolve({
          read: async () => delayed.promise,
          close() {},
        }),
      },
    )
    read({ id: 'rebound-during-read' })
    await setImmediate()
    threads.bindThread({
      ws: client,
      card: state.cards[HYDRA_CARD]!,
    })
    delayed.resolve(latest)
    await setImmediate()
    assert.equal(
      received.length,
      0,
    )
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.deepEqual(
      received.map(message => message.type === 'error' && [
        message.id,
        message.code,
      ]),
      [
        [
          'rebound-during-read',
          'THREAD_CANCELLED',
        ],
      ],
    )
  },
)

test(
  'a mounted conversation resyncs unchanged text and sends no stale page to a closed tab',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-resync-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const resources: { mounted?: Awaited<ReturnType<typeof mountOwnedHydra>> } = {}
    t.after(async () => {
      t.mock.timers.reset()
      await resources.mounted?.close()

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
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    const path = join(
      home,
      'native.jsonl',
    )
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-09T00:00:00Z',
        message: {
          role: 'assistant',
          content: 'The complete saved reply.',
        },
      })}\n`,
    )
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-09T00:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    state.cards[HYDRA_CARD]!.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
      transcriptPath: path,
    }
    state.cards.first = {
      ...state.cards[HYDRA_CARD]!,
      id: 'first',
      key: 'first',
      title: 'First',
      agent: {
        provider: 'claude-code',
        sessionId: 'first',
        transcriptPath: path,
      },
    }
    state.cards.second = {
      ...state.cards[HYDRA_CARD]!,
      id: 'second',
      key: 'second',
      title: 'Second',
      agent: undefined,
    }
    writeSnapshot({
      dir,
      state,
      offset: 0,
    })
    const mount = await mountOwnedHydra({
      hydraId: 'default',
      url: 'http://127.0.0.1/',
      homes: [],
      open: async () => 'http://127.0.0.1/',
      hydrasChanged() {},
      upgradeStatus: () => undefined,
    })
    resources.mounted = mount
    const received: ServerMessage[] = []
    let buffered = 0
    const networkClient = (): HydraClient => ({
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        received.push(message)
      },
      terminate() {},
    })
    const tab = mount.connect({
      ws: networkClient(),
      after: null,
    })
    tab.receive({
      message: {
        type: 'command',
        id: 'read',
        name: 'thread',
        args: [HYDRA_CARD],
      },
    })
    await setImmediate()
    const first = received.find(message => message.type === 'receipt' && message.id === 'read')
    assert.ok(first?.type === 'receipt')
    const initial = first.thread as ThreadPage
    assert.equal(
      initial.conversation!.entries[0]!.text,
      'The complete saved reply.',
    )
    t.mock.timers.enable({ apis: ['setTimeout'] })
    received.length = 0
    tab.receive({ message: { type: 'resync' } })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.ok(received.some(message => message.type === 'snapshot'))
    const refreshed = received.find(message => message.type === 'thread')
    assert.ok(refreshed?.type === 'thread')
    assert.equal(
      refreshed.thread.conversation!.entries[0]!.text,
      'The complete saved reply.',
    )
    buffered = MAX_BUFFERED + 1
    tab.receive({ message: { type: 'resync' } })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    const beforeClose = received.length
    tab.close()
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.equal(
      received.length,
      beforeClose,
    )
    const reconnected = mount.connect({
      ws: networkClient(),
      after: null,
    })
    reconnected.receive({
      message: {
        type: 'command',
        id: 'reconnected',
        name: 'thread',
        args: [HYDRA_CARD],
      },
    })
    await setImmediate()
    const reply = received.find(message => message.type === 'receipt' && message.id === 'reconnected')
    assert.ok(reply?.type === 'receipt')
    const restored = reply.thread as ThreadPage
    assert.equal(
      restored.conversation!.entries[0]!.text,
      'The complete saved reply.',
    )
    assert.notEqual(
      restored.conversation!.stream,
      initial.conversation!.stream,
    )
    buffered = MAX_BUFFERED + 1
    reconnected.receive({
      message: {
        type: 'command',
        id: 'first-card',
        name: 'thread',
        args: ['first'],
      },
    })
    await setImmediate()
    reconnected.receive({
      message: {
        type: 'command',
        id: 'second-card',
        name: 'thread',
        args: ['second'],
      },
    })
    await setImmediate()
    reconnected.receive({
      message: {
        type: 'command',
        id: 'closes-during-read',
        name: 'thread',
        args: ['first'],
      },
    })
    const beforeFinalClose = received.length
    reconnected.close()
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    assert.equal(
      received.length,
      beforeFinalClose,
    )
    t.mock.timers.reset()
  },
)

function deferred<T>() {
  // eslint-disable-next-line pnyx/object-params -- Promise resolver contract.
  let complete: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>(resolve => {
    complete = resolve
  })
  assert.ok(complete)

  return {
    promise,
    resolve: complete,
  }
}

test(
  'a Hydra subscription assembles a turn across pages and retains it on refresh',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-thread-subscription-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      ; rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-06T00:00:00Z',
        actor: 'web',
        cardId: HYDRA_CARD,
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    const latest: ThreadPage = {
      card: HYDRA_CARD,
      session: 'fixture',
      route: true,
      watching: 'unknown',
      older: 'polder',
      entries: [
        {
          id: 'answer',
          kind: 'message',
          role: 'assistant',
          text: 'Ready',
          at: '2026-11-06T00:00:02Z',
        },
      ],
    }
    const past: ThreadPage = {
      ...latest,
      older: undefined,
      entries: [
        {
          id: 'owner',
          kind: 'message',
          role: 'user',
          text: 'Check it',
          at: '2026-11-06T00:00:01Z',
        },
      ],
    }
    const sub: Subscription = {
      card: HYDRA_CARD,
      native: Promise.resolve({
        read: async ({ before }) => before ? past : latest,
        close() {},
      }),
    }
    const pushed: ServerMessage[] = []
    const threads = createThreadSubscriptions({
      hydraId: 'default',
      state: () => state,
      homes: () => [],
      closed: () => false,
      send({ message }) {
        pushed.push(message)

        return true
      },
      agents: () => ({ thread: ({ page }) => page }),
    })
    const card = state.cards[HYDRA_CARD]!
    const first = await threads.threadPage({
      sub,
      card,
    })
    const older = await threads.threadPage({
      sub,
      card,
      before: first.older,
    })
    assert.deepEqual(
      older.conversation!.entries.map(entry => entry.id),
      [
        'owner',
        'answer',
      ],
    )
    assert.equal(
      older.conversation!.timings.answer!.start,
      past.entries[0]!.at,
    )
    const refreshed = await threads.threadPage({
      sub,
      card,
    })
    assert.deepEqual(
      refreshed.conversation!.entries.map(entry => entry.id),
      [
        'owner',
        'answer',
      ],
    )
    assert.equal(
      refreshed.conversation!.stream,
      first.conversation!.stream,
    )
    assert.ok(refreshed.conversation!.version! > older.conversation!.version!)
    const restored = await threads.threadPage({
      sub: {
        card: HYDRA_CARD,
        native: sub.native,
      },
      card,
      retain: {
        session: latest.session,
        oldest: past.entries[0]!.id,
      },
    })
    assert.deepEqual(
      restored.conversation!.entries.map(entry => entry.id),
      [
        'owner',
        'answer',
      ],
    )
    assert.notEqual(
      restored.conversation!.stream,
      first.conversation!.stream,
    )
    assert.equal(
      restored.older,
      undefined,
    )
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const requested = deferred<void>()
    const release = deferred<ThreadPage>()
    let newest = latest
    const client: HydraClient = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send() {},
      terminate() {},
    }
    const restoringSub: Subscription = {
      card: HYDRA_CARD,
      client,
      native: Promise.resolve({
        read: async ({ before }) => {
          if (before) {
            requested.resolve()

            return release.promise
          }

          return newest
        },
        close() {},
      }),
    }
    threads.subscriptionMap({ card: HYDRA_CARD }).set(
      client,
      restoringSub,
    )
    const restoring = threads.threadPage({
      sub: restoringSub,
      card,
      retain: {
        session: latest.session,
        oldest: past.entries[0]!.id,
      },
    })
    await requested.promise
    newest = {
      ...latest,
      entries: [
        {
          ...latest.entries[0]!,
          text: 'Updated answer',
        },
      ],
    }
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.equal(
      pushed.length,
      0,
    )
    release.resolve(past)
    await restoring
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.deepEqual(
      pushed
        .filter(message => message.type === 'thread')
        .flatMap(message => message.thread.conversation!.entries.map(entry => entry.text)),
      [
        'Check it',
        'Updated answer',
      ],
    )
  },
)
