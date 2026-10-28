import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '../../../src/app/reducer.ts'
import type { HydraEvent } from '../../../src/app/model.ts'
import { DEFAULT_COLUMNS } from '../../../src/tasks/column-defaults.ts'
import { optimisticState, projectEdits } from './optimistic.ts'

const fixture = () => {
  const events: HydraEvent[] = [
    {
      v: 1,
      seq: 1,
      id: 'config',
      at: '2026-10-16T12:00:00Z',
      actor: 'test',
      cardId: '$board',
      type: 'board.configured',
      data: {
        id: 'default',
        name: 'Default',
        hydra: {
          id: 'hydra',
          kind: 'agent',
          name: 'Hydra',
        },
        columns: structuredClone(DEFAULT_COLUMNS),
      },
    },
    ...[
      'one',
      'two',
      'three',
    ].map((
      id,
      i,
    ): HydraEvent => ({
      v: 1,
      seq: i + 2,
      id,
      at: '2026-10-16T12:00:00Z',
      actor: 'test',
      cardId: id,
      type: 'task.created',
      data: {
        key: id,
        title: id,
        column: 'queued',
      },
    })),
  ]

  return replay({
    state: emptyHydra(),
    events,
  })
}

test(
  'overlapping view edits merge over live state without changing server revisions',
  () => {
    const original = fixture()
    const first = optimisticState({
      state: original,
      edit: {
        name: 'view',
        args: [
          'set',
          '--json',
          '{"columnWidths":{"queued":400}}',
        ],
      },
    })
    const second = optimisticState({
      state: first,
      edit: {
        name: 'view',
        args: [
          'set',
          '--json',
          '{"cardHeight":320,"columnWidths":{"parked":360}}',
        ],
      },
    })
    assert.equal(
      second.view?.columnWidths.queued,
      400,
    )
    assert.equal(
      second.view?.columnWidths.parked,
      360,
    )
    assert.equal(
      second.view?.cardHeight,
      320,
    )
    assert.equal(
      second.seq,
      original.seq,
    )
    assert.equal(
      second.viewRevision,
      original.viewRevision,
    )
    assert.equal(
      original.view,
      undefined,
    )
  },
)

test(
  'moves preview the server order and preserve unrelated cards',
  () => {
    const original = fixture()
    const result = optimisticState({
      state: original,
      edit: {
        name: 'move',
        args: [
          'three',
          'queued',
          '--before',
          'two',
        ],
      },
    })
    assert.ok(result.cards.three!.rank! > (result.cards.one!.rank ?? result.cards.one!.createdSeq))
    assert.ok(result.cards.three!.rank! < (result.cards.two!.rank ?? result.cards.two!.createdSeq))
    assert.equal(
      result.cards.one,
      original.cards.one,
    )
    const moved = optimisticState({
      state: result,
      edit: {
        name: 'move',
        args: [
          'three',
          'parked',
        ],
      },
    })
    assert.equal(
      moved.cards.three?.column,
      'parked',
    )
    assert.equal(
      original.cards.three?.column,
      'queued',
    )
  },
)

test(
  'a rejected prerequisite drops invalid dependent previews and preserves independent edits',
  () => {
    const state = fixture()
    const invalid: string[] = []
    const projected = projectEdits({
      state,
      edits: [
        {
          name: 'view',
          args: [
            'set',
            '--json',
            '{"columnWidths":{"custom:pending":400}}',
          ],
        },
        {
          name: 'view',
          args: [
            'set',
            '--json',
            '{"theme":"dark"}',
          ],
        },
      ],
      invalid: ({ edit }) => {
        invalid.push(edit.name)
      },
    })
    assert.deepEqual(
      invalid,
      ['view'],
    )
    assert.equal(
      projected.view?.theme,
      'dark',
    )
    assert.equal(
      projected.view?.columnWidths['custom:pending'],
      undefined,
    )
    assert.equal(
      state.view,
      undefined,
    )
  },
)
