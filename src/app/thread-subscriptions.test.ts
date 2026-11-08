import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
