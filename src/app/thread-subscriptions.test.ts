import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, reduce } from './reducer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { createThreadSubscriptions, type Subscription } from './thread-subscriptions.ts'

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
    const threads = createThreadSubscriptions({
      hydraId: 'default',
      state: () => state,
      homes: () => [],
      closed: () => false,
      send() {},
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
  },
)
