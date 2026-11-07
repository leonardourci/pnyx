import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { emptyHydra, reduce, replay } from '#app/reducer.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { columnCards } from '#tasks/select.ts'
import { optimisticState } from './optimistic.ts'

const created = ({ key }: { key: string }): HydraEvent => ({
  v: 1,
  seq: key === 'first' ? 1 : 2,
  id: key,
  at: '2026-11-06T00:00:00Z',
  actor: 'web',
  cardId: key,
  type: 'task.created',
  data: {
    key,
    title: key,
    column: 'queued',
  },
})

test(
  'a create preview shows the task where the server will place it before its target',
  () => {
    const state = replay({
      state: emptyHydra(),
      events: [
        created({ key: 'first' }),
        created({ key: 'last' }),
      ],
    })
    const preview = optimisticState({
      state,
      edit: {
        name: 'task',
        args: [
          'create',
          '--title',
          'Middle',
          '--column',
          'queued',
          '--before',
          'last',
          '--event-id',
          'middle',
        ],
      },
    })
    const decision = planTaskChange({
      state,
      hydraId: 'default',
      cardId: 'task:middle',
      operation: {
        op: 'task.create',
        key: 'task:middle',
        title: 'Middle',
        column: 'queued',
        before: 'last',
      },
      meta: {
        at: '2026-11-06T00:00:01Z',
        actor: 'web',
        id: 'middle',
      },
      landing: new Map(),
    })
    assert.ok('event' in decision)
    const confirmed = reduce({
      state,
      event: decision.event,
    })

    assert.deepEqual(
      columnCards({
        state: preview,
        column: 'queued',
      }).map(card => card.id),
      [
        'first',
        'task:middle',
        'last',
      ],
    )
    assert.deepEqual(
      columnCards({
        state: confirmed,
        column: 'queued',
      }).map(card => card.id),
      [
        'first',
        'task:middle',
        'last',
      ],
    )
    assert.equal(
      preview.cards['task:middle']!.rank,
      confirmed.cards['task:middle']!.rank,
    )
  },
)
