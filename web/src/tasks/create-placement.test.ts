import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { createBeforeRank } from '#tasks/create-placement.ts'
import { optimisticState } from './optimistic.ts'

test(
  'a create preview uses the server position for its before target',
  () => {
    let state = emptyHydra()
    const column = hydraConfig({ state }).columns.find(column => column.role === 'queued')!.id

    for (const [
      index,
      id,
    ] of [
        'first',
        'last',
      ].entries()) {
      state = reduce({
        state,
        event: {
          v: 1,
          seq: index + 1,
          id,
          at: '2026-11-06T00:00:00Z',
          actor: 'web',
          cardId: id,
          type: 'task.created',
          data: {
            key: id,
            title: id,
            column,
          },
        },
      })
    }

    const preview = optimisticState({
      state,
      edit: {
        name: 'task',
        args: [
          'create',
          '--title',
          'Middle',
          '--column',
          column,
          '--before',
          'last',
          '--event-id',
          'middle',
        ],
      },
    })
    assert.equal(
      preview.cards['task:middle']!.rank,
      createBeforeRank({
        state,
        column,
        before: 'last',
      }),
    )
  },
)
