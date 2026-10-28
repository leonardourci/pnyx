import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { readStream } from '#test-harness/streams.ts'

test(
  'legacy reply delivery history replays without inventing handled instructions',
  () => {
    const events = readStream({ name: 'lifecycle' })
    const receipt: HydraEvent = {
      v: 1,
      seq: events.length + 1,
      id: 'legacy-delivery',
      actor: 'cli',
      at: '2026-10-23T10:00:00Z',
      cardId: 'c1',
      type: 'card.replied',
      data: {
        reply: 'old-reply',
        state: 'delivered',
        route: 'pnyx',
        taskMessage: true,
        text: 'Already delivered',
      },
    }
    const log = [
      ...events,
      receipt,
    ]
    const before = JSON.stringify(log)
    const state = replay({
      state: emptyHydra(),
      events: log,
    })
    assert.deepEqual(
      state.cards.c1!.replies,
      [
        {
          id: 'old-reply',
          state: 'delivered',
          route: 'pnyx',
        },
      ],
    )
    assert.equal(
      state.cards.c1!.steering,
      undefined,
    )
    assert.equal(
      JSON.stringify(log),
      before,
    )
  },
)
