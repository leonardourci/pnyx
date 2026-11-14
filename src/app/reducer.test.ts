import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { emptyHydra, replay } from './reducer.ts'
import { assertGolden, readStream } from '#test-harness/streams.ts'

for (const name of [
  'lifecycle',
  'duplicates',
  'pinned-attention',
  'undo',
  'tasks',
  'hydra',
]) {
  test(
    `golden replay: ${name}`,
    () => {
      assertGolden({
        name,
        actual: replay({
          state: emptyHydra(),
          events: readStream({ name }),
        }),
      })
    },
  )
}

test(
  'lifecycle: pull requests, merges and outcomes never move a card',
  () => {
    const events = readStream({ name: 'lifecycle' })

    for (let seq = 1; seq <= events.length; seq++) {
      const state = replay({
        state: emptyHydra(),
        events: events.slice(
          0,
          seq,
        ),
      })
      assert.equal(
        state.cards.c1!.column,
        'in_progress',
        `after event ${seq}`,
      )
    }

    const end = replay({
      state: emptyHydra(),
      events,
    })
    assert.equal(
      end.cards.c2!.parentId,
      'c1',
    )
    assert.equal(
      end.cards.c2!.column,
      'in_progress',
    )
    assert.equal(
      end.cards.c1!.links.filter(l => l.state === 'merged').length,
      2,
    )
  },
)

test(
  'replay is pure and deterministic',
  () => {
    const events = readStream({ name: 'lifecycle' })
    const start = emptyHydra()
    const frozen = structuredClone(start)
    const once = replay({
      state: start,
      events,
    })
    assert.deepEqual(
      start,
      frozen,
    )
    assert.deepEqual(
      replay({
        state: replay({
          state: start,
          events: events.slice(
            0,
            4,
          ),
        }),
        events: events.slice(4),
      }),
      once,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events,
      }),
      once,
    )
  },
)

test(
  'a parent change that would make a cycle is ignored',
  () => {
    const events = readStream({ name: 'lifecycle' })
    const cycle: HydraEvent = {
      v: 1,
      seq: 9,
      id: 'evt_9',
      at: '2026-10-13T10:09:00Z',
      actor: 'cli',
      cardId: 'c1',
      type: 'card.pushed',
      data: {
        key: 'claude:host-a:sess-1',
        parentId: 'c2',
      },
    }
    assert.equal(
      replay({
        state: emptyHydra(),
        events: [
          ...events,
          cycle,
        ],
      }).cards.c1!.parentId,
      undefined,
    )
  },
)

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

test(
  'a decision shares untouched cards and state branches without changing its input or event',
  () => {
    const state = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    })
    const snapshot = structuredClone(state)
    const event: HydraEvent = {
      v: 1,
      id: 'edit-one-card',
      seq: state.seq + 1,
      at: '2026-11-13T22:00:00.000Z',
      actor: 'cli',
      cardId: 'c1',
      type: 'card.moved',
      data: {
        before: 'in_progress',
        after: 'queued',
      },
    }
    const savedEvent = structuredClone(event)
    const next = replay({
      state,
      events: [event],
    })
    assert.deepEqual(
      state,
      snapshot,
    )
    assert.deepEqual(
      event,
      savedEvent,
    )
    assert.notEqual(
      next.cards.c1,
      state.cards.c1,
    )
    assert.equal(
      next.cards.c2,
      state.cards.c2,
    )
    assert.equal(
      next.keys,
      state.keys,
    )
    assert.equal(
      next.undone,
      state.undone,
    )
    assert.equal(
      next.cards.c1?.column,
      'queued',
    )
  },
)
