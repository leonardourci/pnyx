import { recentThreadPages, RECENT_THREAD_ENTRIES, THREAD_PAGE_LIMIT } from '#hydra/thread-history.ts'
import { createThreadReceiver } from '#hydra/thread-receive.ts'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { LATEST_DELAY_MS } from './latest-feed.ts'
import type { HydraClient, ServerMessage } from './server-transport.ts'
import type { Decision, HydraEvent } from './model.ts'
import { emptyHydra, reduce } from './reducer.ts'
import { liveReplies } from '#workers/streaming.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { LIVE_TEXT_DELAY_MS, createThreadSubscriptions, type Subscription } from './thread-subscriptions.ts'
import { createServerClients } from './server-clients.ts'
import { MAX_BUFFERED } from './server-transport.ts'
import { SOCKET_RETRY_MS } from './server-transport.ts'
import { threadCommand } from '#app/server-commands/thread.ts'
import { mountOwnedHydra } from './server.ts'
import { withWriter } from './writer.ts'
import { decidePush } from '#tasks/push.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { hydraConfig } from '#hydra/config.ts'

// Copies of the two-record fixture that make a transcript longer than the recent pages.
const RECENT_WINDOW_COPIES = 120

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
    const wire: ServerMessage[] = []
    const receiver = createThreadReceiver()
    let resyncs = 0
    const client: HydraClient = {
      OPEN: 1,
      get readyState() {
        return readyState
      },
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        wire.push(message)
        const normalized = receiver.receive({ message })

        if (normalized) {
          received.push(normalized)
        } else {
          resyncs += 1
          threads.refreshThread({
            ws: client,
            resync: true,
          })
        }
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
    assert.ok(wire.some(message => message.type === 'thread.delta'))
    t.mock.timers.tick(LATEST_DELAY_MS)
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
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    await setImmediate()
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.equal(
      resyncs,
      0,
      'replacing an undelivered page must not require receiver recovery',
    )
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
      delivered.at(-1)!.thread.stream,
      delivered[0]!.thread.stream,
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
    withWriter({
      hydraId: 'default',
      create: true,
      fn: ({ writer }) => {
        const meta = {
          actor: 'web',
          at: '2026-11-09T00:00:00Z',
        }

        const apply = ({ decision }: { decision: Decision }) => {
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        }

        const create = ({ key }: { key: string }) => writer.append({
          event: {
            ...meta,
            v: 1,
            seq: writer.state.seq + 1,
            id: `create-${key}`,
            cardId: key,
            type: 'task.created',
            data: {
              key,
              title: key,
            },
          },
        })
        const attach = ({
          key,
          sessionId,
        }: {
          key: string
          sessionId: string
        }) => apply({
          decision: decidePush({
            state: writer.state,
            key,
            input: {
              agent: {
                provider: 'claude-code',
                sessionId,
                transcriptPath: path,
              },
            },
            meta,
          }),
        })
        attach({
          key: 'hydra-session',
          sessionId: 'fixture',
        })
        const config = hydraConfig({ state: writer.state })
        apply({
          decision: hydraEvent({
            state: writer.state,
            meta,
            cardId: HYDRA_CARD,
            change: {
              type: 'board.configured',
              data: {
                ...config,
                hydra: {
                  ...config.hydra,
                  session: 'claude-code:fixture',
                },
              },
            },
          }),
        })
        create({ key: 'first' })
        attach({
          key: 'first',
          sessionId: 'first',
        })
        create({ key: 'second' })
      },
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
      restored.stream,
      initial.stream,
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
  'a Hydra subscription assembles a turn across pages, retains it on refresh, and keeps a recent window bounded',
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
      refreshed.stream,
      first.stream,
    )
    assert.ok(refreshed.version! > older.version!)
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
      restored.stream,
      first.stream,
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
    const pageFor = ({
      index,
      older,
    }: {
      index: number
      older?: string
    }): ThreadPage => ({
      ...latest,
      older,
      entries: [
        {
          id: `entry-${index}`,
          kind: 'message',
          role: 'assistant',
          text: `Reply ${index}`,
          final: true,
          at: `2026-11-06T00:00:0${index}Z`,
        },
      ],
    })
    const pages: Record<string, ThreadPage> = {
      latest: pageFor({
        index: 4,
        older: 'p3',
      }),
      p3: pageFor({
        index: 3,
        older: 'p2',
      }),
      p2: pageFor({
        index: 2,
        older: 'p1',
      }),
      p1: pageFor({ index: 1 }),
    }
    let blocked = false
    const recentRequested = deferred<void>()
    const recentRelease = deferred<ThreadPage>()
    const archiveReads: string[] = []
    const archive: Subscription = {
      card: HYDRA_CARD,
      client,
      native: Promise.resolve({
        read: async ({ before }) => {
          archiveReads.push(before ?? 'latest')

          if (blocked && before === 'p5') {
            recentRequested.resolve()

            return recentRelease.promise
          }

          return pages[before ?? 'latest']!
        },
        close() {},
      }),
    }
    threads.subscriptionMap({ card: HYDRA_CARD }).set(
      client,
      archive,
    )
    const archiveFirst = await threads.threadPage({
      sub: archive,
      card,
    })
    const archiveSecond = await threads.threadPage({
      sub: archive,
      card,
      before: archiveFirst.older,
    })
    const archiveThird = await threads.threadPage({
      sub: archive,
      card,
      before: archiveSecond.older,
    })
    const expanded = await threads.threadPage({
      sub: archive,
      card,
      before: archiveThird.older,
    })
    assert.equal(
      expanded.pages,
      4,
    )
    assert.deepEqual(
      expanded.entries.map(entry => entry.id),
      [
        'entry-1',
        'entry-2',
        'entry-3',
        'entry-4',
      ],
    )
    const recent = await threads.threadPage({
      sub: archive,
      card,
      recent: true,
    })
    assert.equal(
      recent.pages,
      3,
    )
    assert.equal(
      recent.recent,
      true,
    )
    assert.deepEqual(
      recent.entries.map(entry => entry.id),
      [
        'entry-2',
        'entry-3',
        'entry-4',
      ],
    )
    assert.equal(
      recent.older,
      archiveThird.older,
    )
    assert.equal(
      archive.history?.entries.some(entry => entry.id === 'entry-1'),
      false,
    )
    pages.p4 = pages.latest!
    pages.latest = pageFor({
      index: 5,
      older: 'p4',
    })
    archiveReads.length = 0
    pushed.length = 0
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.deepEqual(
      archiveReads,
      ['latest'],
      'one arrival rereads no older page',
    )
    const arrival = pushed.at(-1)
    assert.ok(arrival?.type === 'thread')
    assert.equal(
      arrival.thread.recent,
      true,
    )
    assert.deepEqual(
      arrival.thread.entries.map(entry => entry.id),
      [
        'entry-2',
        'entry-3',
        'entry-4',
        'entry-5',
      ],
    )
    const earlierAgain = await threads.threadPage({
      sub: archive,
      card,
      before: archiveSecond.older,
    })
    assert.equal(
      earlierAgain.recent,
      false,
    )
    assert.deepEqual(
      earlierAgain.entries.map(entry => entry.id),
      [
        'entry-2',
        'entry-3',
        'entry-4',
        'entry-5',
      ],
    )
    pages.p5 = pages.latest
    pages.latest = pageFor({
      index: 6,
      older: 'p5',
    })
    threads.refreshThread({ ws: client })
    t.mock.timers.tick(LATEST_DELAY_MS)
    await setImmediate()
    assert.deepEqual(
      archive.history?.entries.map(entry => entry.id),
      [
        'entry-2',
        'entry-3',
        'entry-4',
        'entry-5',
        'entry-6',
      ],
    )
    const recentered = await threads.threadPage({
      sub: archive,
      card,
      recent: true,
    })
    assert.deepEqual(
      recentered.entries.map(entry => entry.id),
      [
        'entry-4',
        'entry-5',
        'entry-6',
      ],
    )
    blocked = true
    const superseded = assert.rejects(
      threads.threadPage({
        sub: archive,
        card,
        recent: true,
      }),
      { code: 'THREAD_SUPERSEDED' },
    )
    await recentRequested.promise
    const chosenOlder = await threads.threadPage({
      sub: archive,
      card,
      before: archiveFirst.older,
    })
    recentRelease.resolve(pages.p5!)
    await superseded
    assert.equal(
      chosenOlder.recent,
      false,
    )
    assert.deepEqual(
      archive.history?.entries.map(entry => entry.id),
      [
        'entry-3',
        'entry-4',
        'entry-5',
        'entry-6',
      ],
    )
    const stalled = {
      ...latest,
      older: 'same-cursor',
    }
    await assert.rejects(
      recentThreadPages({
        page: stalled,
        read: async () => stalled,
      }),
      { code: 'THREAD_HISTORY_STALLED' },
    )
  },
)

test(
  'live refreshes retain history and pick up native bytes, settings, explicit reads, session changes and recent window arrivals',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-live-cache-',
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
    t.mock.timers.enable({
      apis: [
        'setTimeout',
        'Date',
      ],
      now: Date.parse('2026-11-07T00:00:00Z'),
    })
    const created: HydraEvent[] = [
      {
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
      {
        v: 1,
        seq: 2,
        id: 'create-task',
        at: '2026-11-06T00:00:00Z',
        actor: 'web',
        cardId: 'checklist',
        type: 'task.created',
        data: {
          key: 'checklist',
          title: 'Release checklist',
        },
      },
    ]
    let state = created.reduce(
      (
        hydra,
        event,
      ) => reduce({
        state: hydra,
        event,
      }),
      emptyHydra(),
    )
    const path = join(
      home,
      'native.jsonl',
    )
    copyFileSync(
      join(
        import.meta.dirname,
        'fixtures',
        'live-thread.jsonl',
      ),
      path,
    )
    let card = state.cards[HYDRA_CARD]!
    card.agent = {
      provider: 'claude-code',
      sessionId: 'fixture',
      transcriptPath: path,
    }
    const live = liveReplies()
    live.start({
      offset: 0,
      ownerStarted: true,
    })
    const ws: HydraClient = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send() {},
      terminate() {},
    }
    const pushed: ThreadPage[] = []
    const wire: ServerMessage['type'][] = []
    const receiver = createThreadReceiver()
    const threads = createThreadSubscriptions({
      hydraId: 'default',
      state: () => state,
      homes: () => [],
      closed: () => false,
      agents: () => ({ thread: ({ page }) => live.page({ page }) }),
      send: ({ message }) => {
        wire.push(message.type)
        const normalized = receiver.receive({ message })

        if (normalized?.type === 'thread') {
          pushed.push(normalized.thread)
        } else if (!normalized) {
          threads.refreshThread({
            ws,
            resync: true,
          })
        }

        return true
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
    tabs.clients.add(ws)
    t.after(() => tabs.close())
    threads.bindThread({
      ws,
      card,
    })
    t.after(() => threads.subscriptionMap({ card: HYDRA_CARD }).get(ws)?.watcher?.close())

    const refresh = () => {
      threads.refreshThread({
        ws,
        invalidate: false,
      })
      t.mock.timers.tick(LATEST_DELAY_MS)
    }

    live.update({
      id: 'answer',
      text: 'First words',
      append: true,
    })
    threads.refreshLiveThread({
      ws,
      card: HYDRA_CARD,
    })
    assert.equal(
      pushed.length,
      1,
      'the first words arrive without a cadence timer',
    )
    assert.deepEqual(
      pushed.at(-1)!.conversation!.entries.map(entry => entry.text),
      [
        'Explain it',
        'First words',
      ],
    )
    live.update({
      id: 'answer',
      text: ' and more.',
      append: true,
    })
    threads.refreshLiveThread({
      ws,
      card: HYDRA_CARD,
    })
    t.mock.timers.tick(LIVE_TEXT_DELAY_MS - 1)
    assert.equal(
      pushed.length,
      1,
      'a burst waits for its coalescing window',
    )
    t.mock.timers.tick(1)
    assert.equal(
      pushed.length,
      2,
    )
    assert.deepEqual(
      pushed.at(-1)!.conversation!.entries.map(entry => entry.text),
      [
        'Explain it',
        'First words and more.',
      ],
    )
    const action: HydraEvent = {
      v: 1,
      seq: 3,
      id: 'checklist-done',
      at: new Date().toISOString(),
      actor: 'hydra',
      cardId: 'checklist',
      type: 'task.declared',
      data: {
        state: 'done',
        note: 'Checks complete',
      },
    }
    withWriter({
      hydraId: 'default',
      create: true,
      migrate: false,
      fn: ({ writer }) => {
        for (const event of [
          ...created,
          action,
        ]) {
          writer.append({ event })
        }
      },
    })
    state = reduce({
      state,
      event: action,
    })
    state.cards[HYDRA_CARD]!.agent = card.agent
    card = state.cards[HYDRA_CARD]!
    tabs.broadcast({ event: action })
    live.update({
      id: 'answer',
      text: 'First words and more.',
      append: false,
    })
    threads.refreshLiveThread({
      ws,
      card: HYDRA_CARD,
    })
    t.mock.timers.tick(LIVE_TEXT_DELAY_MS)
    assert.deepEqual(
      pushed.at(-1)!.conversation!.folds['live:answer']?.tasks.map(task => ({
        title: task.title,
        states: task.updates.map(update => update.state),
      })),
      [
        {
          title: 'Release checklist',
          states: ['done'],
        },
      ],
    )
    appendFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'First words and more.',
            },
          ],
        },
      }) + '\n',
    )
    live.finish()
    refresh()
    assert.equal(
      pushed.at(-1)!.conversation!.entries.at(-1)!.text,
      'First words and more.',
    )
    assert.equal(
      pushed.at(-1)!.conversation!.entries.at(-1)!.id.startsWith('live:'),
      false,
    )
    const replacement = join(
      home,
      'replacement.jsonl',
    )
    writeFileSync(
      replacement,
      readFileSync(
        path,
        'utf8',
      ).replace(
        'Explain it',
        'Review it!',
      ),
    )
    renameSync(
      replacement,
      path,
    )
    refresh()
    assert.ok(pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'Review it!'))
    assert.ok(!pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'Explain it'))
    state.hydraMessages = [
      {
        id: 'notice',
        hydra: 'hydra',
        actor: 'hydra',
        action: 'send',
        text: 'A new saved notice',
        at: new Date().toISOString(),
      },
    ]
    threads.refreshThread({ ws })
    t.mock.timers.tick(LATEST_DELAY_MS - 1)
    assert.ok(!pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'A new saved notice'))
    t.mock.timers.tick(1)
    assert.ok(pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'A new saved notice'))
    state.hydraMessages.push({
      id: 'explicit-notice',
      hydra: 'hydra',
      actor: 'hydra',
      action: 'send',
      text: 'Notice from an explicit read',
      at: new Date().toISOString(),
    })
    const receipt = await threads.threadPage({
      sub: threads.subscriptionMap({ card: HYDRA_CARD }).get(ws)!,
      card,
    })
    assert.equal(
      receipt.stream,
      pushed.at(-1)!.stream,
    )
    assert.ok(receipt.conversation!.entries.some(entry => entry.text === 'A new saved notice'))
    assert.ok(receipt.conversation!.entries.some(entry => entry.text === 'Notice from an explicit read'))
    assert.ok(receipt.entries.some(entry => entry.text === 'First words and more.'))
    card.agent = {
      provider: 'claude-code',
      transcriptPath: path,
      sessionId: 'replacement',
    }
    writeFileSync(
      path,
      '{"type":"user","timestamp":"2026-11-06T00:00:01Z","message":{"role":"user","content":"New session"}}\n',
    )
    live.start({
      offset: 0,
      ownerStarted: true,
    })
    refresh()
    assert.ok(pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'New session'))
    assert.ok(!pushed.at(-1)!.conversation!.entries.some(entry => entry.text === 'Explain it'))
    live.update({
      id: 'next',
      text: 'First words after idle',
      append: true,
    })
    threads.refreshLiveThread({
      ws,
      card: HYDRA_CARD,
    })
    assert.equal(
      pushed.at(-1)!.conversation!.entries.at(-1)!.text,
      'First words after idle',
    )
    live.update({
      id: 'next',
      text: ' pending',
      append: true,
    })
    threads.refreshLiveThread({
      ws,
      card: HYDRA_CARD,
    })
    threads.bindThread({
      ws,
      card,
    })
    t.mock.timers.tick(LIVE_TEXT_DELAY_MS)
    assert.equal(
      pushed.at(-1)!.conversation!.entries.at(-1)!.text,
      'First words after idle',
    )
    state.hydraMessages = []
    card.agent = {
      provider: 'claude-code',
      sessionId: 'paged',
      transcriptPath: path,
    }
    writeFileSync(
      path,
      readFileSync(
        join(
          import.meta.dirname,
          'fixtures',
          'live-thread.jsonl',
        ),
        'utf8',
      ).repeat(40),
    )
    live.start({
      offset: 0,
      ownerStarted: true,
    })
    live.update({
      id: 'paged-answer',
      text: 'A live page',
      append: false,
    })
    threads.bindThread({
      ws,
      card,
    })
    const pagedSub = threads.subscriptionMap({ card: HYDRA_CARD }).get(ws)!
    const latestPage = await threads.threadPage({
      sub: pagedSub,
      card,
    })
    assert.ok(latestPage.older)
    const olderPage = await threads.threadPage({
      sub: pagedSub,
      card,
      before: latestPage.older,
    })
    assert.ok(olderPage.conversation!.entries.some(entry => entry.text === 'A live page'))
    assert.ok(olderPage.entries.length > latestPage.entries.length)
    await threads.threadPage({
      sub: pagedSub,
      card,
      retain: {
        session: latestPage.session,
        oldest: latestPage.entries[0]!.id,
      },
    })
    live.update({
      id: 'paged-answer',
      text: ' keeps growing.',
      append: true,
    })
    const grownPage = await threads.threadPage({
      sub: pagedSub,
      card,
      before: latestPage.older,
    })
    assert.deepEqual(
      grownPage.entries.filter(entry => entry.id.startsWith('live:')).map(entry => entry.text),
      ['A live page keeps growing.'],
    )
    assert.ok(grownPage.conversation!.entries.some(entry => entry.text === 'A live page keeps growing.'))
    live.start({
      offset: 0,
      ownerStarted: true,
    })
    card.agent = {
      provider: 'claude-code',
      sessionId: 'windowed',
      transcriptPath: path,
    }
    writeFileSync(
      path,
      readFileSync(
        join(
          import.meta.dirname,
          'fixtures',
          'live-thread.jsonl',
        ),
        'utf8',
      ).repeat(RECENT_WINDOW_COPIES),
    )
    threads.bindThread({
      ws,
      card,
    })
    const windowSub = threads.subscriptionMap({ card: HYDRA_CARD }).get(ws)!
    const window = await threads.threadPage({
      sub: windowSub,
      card,
      recent: true,
      receipt: 'recent-window',
    })
    assert.equal(
      window.recent,
      true,
    )
    assert.equal(
      window.pages,
      3,
    )
    assert.ok(window.older)
    const oldest = window.entries[0]!.id

    const appendReplies = ({
      count,
      text,
    }: {
      count: number
      text: string
    }) => appendFileSync(
      path,
      Array.from(
        { length: count },
        () => JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-06T00:00:03Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text,
              },
            ],
          },
        }) + '\n',
      ).join(''),
    )

    appendReplies({
      count: 1,
      text: 'One more reply',
    })
    wire.length = 0
    refresh()
    const grown = pushed.at(-1)!
    assert.deepEqual(
      wire,
      ['thread.delta'],
      'an arrival in a recent window is sent as a delta',
    )
    assert.equal(
      grown.recent,
      true,
    )
    assert.equal(
      grown.entries[0]!.id,
      oldest,
      'one arrival keeps the window without rereading it',
    )
    assert.equal(
      grown.entries.at(-1)!.text,
      'One more reply',
    )
    appendReplies({
      count: THREAD_PAGE_LIMIT,
      text: 'A page of replies',
    })
    wire.length = 0
    refresh()
    const reset = pushed.at(-1)!
    assert.deepEqual(
      wire,
      ['thread.delta'],
    )
    assert.equal(
      reset.recent,
      true,
    )
    assert.equal(
      reset.pages,
      3,
    )
    assert.ok(
      !reset.entries.some(entry => entry.id === oldest),
      'a page of arrivals resets the window to its recent pages',
    )
    assert.equal(
      reset.entries.at(-1)!.text,
      'A page of replies',
    )
    assert.ok(reset.entries.length <= RECENT_THREAD_ENTRIES)
  },
)
