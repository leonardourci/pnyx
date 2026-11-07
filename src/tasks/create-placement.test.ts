import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce, replay } from '#app/reducer.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { planTaskChange } from './plans.ts'
import { columnCards } from './select.ts'

const at = '2026-11-06T00:00:00Z'

function create({
  state,
  key,
  column,
  before,
  hold,
}: {
  state: HydraState
  key: string
  column?: string
  before?: string
  hold?: boolean
}) {
  const decision = planTaskChange({
    state,
    hydraId: 'default',
    cardId: key,
    operation: {
      op: 'task.create',
      key,
      title: key,
      column,
      before,
      hold,
    },
    meta: {
      at,
      actor: 'web',
      id: key,
    },
    landing: new Map(),
  })
  assert.ok('event' in decision)

  return decision.event
}

test(
  'creation before a task records its final position in one replayable event',
  () => {
    let state = emptyHydra()
    const column = hydraConfig({ state }).columns.find(column => column.role === 'queued')!.id
    const events: HydraEvent[] = []

    for (const key of [
      'first',
      'last',
    ]) {
      const event = create({
        state,
        key,
        column,
      })
      events.push(event)
      state = reduce({
        state,
        event,
      })
    }

    const middle = create({
      state,
      key: 'middle',
      column,
      before: 'last',
    })
    events.push(middle)
    state = reduce({
      state,
      event: middle,
    })
    assert.deepEqual(
      columnCards({
        state,
        column,
      }).map(card => card.key),
      [
        'first',
        'middle',
        'last',
      ],
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events,
      }),
      state,
    )
    const top = create({
      state,
      key: 'top',
      column,
      before: 'first',
    })
    assert.deepEqual(
      columnCards({
        state: reduce({
          state,
          event: top,
        }),
        column,
      }).map(card => card.key),
      [
        'top',
        'first',
        'middle',
        'last',
      ],
    )
  },
)

test(
  'creation rejects a before target outside its effective destination',
  () => {
    let state = emptyHydra()
    const columns = hydraConfig({ state }).columns
    const queued = columns.find(column => column.role === 'queued')!.id
    const other = columns.find(column => column.id !== queued)!.id
    state = reduce({
      state,
      event: create({
        state,
        key: 'elsewhere',
        column: other,
      }),
    })
    assert.throws(
      () => create({
        state,
        key: 'invalid',
        column: queued,
        before: 'elsewhere',
      }),
      /not in column/,
    )
    assert.throws(
      () => create({
        state,
        key: 'missing',
        column: queued,
        before: 'unknown',
      }),
      /not found/,
    )
    assert.throws(
      () => create({
        state,
        key: 'held',
        column: other,
        hold: true,
        before: 'elsewhere',
      }),
      /not in column/,
    )
  },
)
