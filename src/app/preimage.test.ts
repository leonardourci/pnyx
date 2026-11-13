import assert from 'node:assert/strict'
import { test } from 'node:test'
import { preimage } from './preimage.ts'

test(
  'card and session assignments own separate copies, so changing one cannot silently change the other',
  () => {
    const state = {
      cards: { task: { usage: { cost: 0 } } },
      sessions: { worker: { usage: { cost: 0 } } },
    }
    const shared = { cost: 1 }
    const first = preimage({
      state,
      observers: new Set(),
      change: ({ state }) => {
        state.cards.task.usage = shared
        state.sessions.worker.usage = shared
      },
    })
    first.release()
    const touched = {
      cards: new Set<string>(),
      fields: new Set<string>(),
    }
    const next = preimage({
      state,
      observers: new Set(),
      touched,
      change: ({ state }) => {
        state.cards.task.usage.cost = 2
      },
    })
    next.release()
    assert.equal(
      state.cards.task.usage.cost,
      2,
    )
    assert.equal(
      state.sessions.worker.usage.cost,
      1,
    )
    assert.deepEqual(
      [...touched.cards],
      ['task'],
    )
    assert.deepEqual(
      [...touched.fields],
      [],
    )
  },
)
