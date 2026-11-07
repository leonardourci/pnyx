import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'
import { decideMove } from '#tasks/columns-decisions.ts'
import type { Column } from '#tasks/columns-model.ts'
import { optimisticState, projectEdits, type Edit } from './optimistic.ts'

// The queued column takes another id, so a role and an id name different things.
const fixture = ({ queued = 'queued' }: { queued?: Column } = {}) => {
  const columns = structuredClone(DEFAULT_COLUMNS).map(column => column.role === 'queued' ? {
    ...column,
    id: queued,
  } : column)
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
        columns,
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
        column: queued,
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

test(
  'previews resolve columns, place new tasks and bound hide-after as the server does',
  () => {
    const state = fixture({ queued: 'custom:todo' })
    const preview = ({
      name,
      args,
    }: Edit) => optimisticState({
      state,
      edit: {
        name,
        args,
      },
    })
    const create = ({ args }: { args: string[] }) => preview({
      name: 'task',
      args: [
        'create',
        '--title',
        'New',
        '--key',
        'new',
        '--event-id',
        'e1',
        ...args,
      ],
    }).cards.new?.column

    const moved = preview({
      name: 'move',
      args: [
        'three',
        'queued',
        '--before',
        'two',
      ],
    }).cards.three
    const decision = decideMove({
      state,
      ref: 'three',
      column: 'custom:todo',
      before: 'two',
      meta: {
        actor: 'test',
        at: '2026-10-16T12:00:00Z',
      },
    })
    assert.ok('event' in decision && decision.event.type === 'card.moved')
    assert.deepEqual(
      [
        moved?.column,
        moved?.rank,
        decision.event.data.rank,
      ],
      [
        'custom:todo',
        2.5,
        2.5,
      ],
    )

    assert.equal(
      create({ args: [] }),
      'custom:todo',
    )
    assert.equal(
      create({
        args: [
          '--column',
          'Parked',
        ],
      }),
      'parked',
    )
    assert.equal(
      create({
        args: [
          '--column',
          'parked',
          '--hold',
        ],
      }),
      'custom:todo',
    )
    assert.equal(
      create({
        args: [
          '--column',
          'nowhere',
        ],
      }),
      undefined,
    )

    const hideAfter = ({ hours }: { hours: string }) => preview({
      name: 'task',
      args: [
        'hide-after',
        'one',
        hours,
      ],
    })
    assert.equal(
      hideAfter({ hours: '-1' }),
      state,
    )
    assert.equal(
      hideAfter({ hours: 'soon' }),
      state,
    )
    assert.equal(
      hideAfter({ hours: '876001' }),
      state,
    )
    assert.equal(
      hideAfter({ hours: '' }),
      state,
    )

    assert.equal(
      hideAfter({ hours: '12' }).cards.one?.doneAfterHours,
      12,
    )
    assert.equal(
      optimisticState({
        state: hideAfter({ hours: '12' }),
        edit: {
          name: 'task',
          args: [
            'hide-after',
            'one',
            'default',
          ],
        },
      }).cards.one?.doneAfterHours,
      undefined,
    )

    assert.deepEqual(
      preview({
        name: 'column',
        args: [
          'reorder',
          'done',
          '--before',
          'queued',
        ],
      }).config?.columns.map(column => column.id).slice(
        0,
        2,
      ),
      [
        'done',
        'custom:todo',
      ],
    )
    assert.equal(
      preview({
        name: 'column',
        args: [
          'reorder',
          'done',
          '--before',
          'nowhere',
        ],
      }),
      state,
    )
    assert.equal(
      preview({
        name: 'column',
        args: [
          'delete',
          'parked',
          '--to',
          'nowhere',
        ],
      }),
      state,
    )
    const parked = optimisticState({
      state,
      edit: {
        name: 'move',
        args: [
          'one',
          'parked',
        ],
      },
    })
    assert.equal(
      optimisticState({
        state: parked,
        edit: {
          name: 'column',
          args: [
            'delete',
            'parked',
            '--to',
            'queued',
          ],
        },
      }).cards.one?.column,
      'custom:todo',
    )
  },
)
