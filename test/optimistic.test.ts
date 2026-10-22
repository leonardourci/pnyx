import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { DEFAULT_COLUMNS } from '../src/core/hydra.ts'
import { optimisticState, currentRevision, projectEdits } from '../web/src/hydra/optimistic.ts'

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
    const afterFailure = optimisticState({
      state: original,
      edit: {
        name: 'view',
        args: [
          'set',
          '--json',
          '{"cardHeight":320}',
        ],
      },
    })
    assert.equal(
      afterFailure.view?.columnWidths.queued,
      undefined,
    )
    assert.equal(
      afterFailure.view?.cardHeight,
      320,
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
  'renames, visibility, column ordering and Hydra settings preview independently',
  () => {
    const original = fixture()
    const renamed = optimisticState({
      state: original,
      edit: {
        name: 'task',
        args: [
          'rename',
          'one',
          '--title=New title',
        ],
      },
    })
    assert.equal(
      renamed.cards.one?.title,
      'New title',
    )
    const hidden = optimisticState({
      state: renamed,
      edit: {
        name: 'task',
        args: [
          'hide',
          'two',
        ],
      },
    })
    assert.equal(
      hidden.cards.two?.hidden,
      true,
    )
    assert.equal(
      hidden.cards.one?.title,
      'New title',
    )
    const columns = optimisticState({
      state: hidden,
      edit: {
        name: 'column',
        args: [
          'reorder',
          'parked',
          '--before',
          'queued',
        ],
      },
    })
    assert.equal(
      columns.config?.columns[0]?.id,
      'parked',
    )
    const described = optimisticState({
      state: columns,
      edit: {
        name: 'column',
        args: [
          'describe',
          'queued',
          '--description',
          'Next up',
        ],
      },
    })
    assert.equal(
      described.config?.columns.find(c => c.id === 'queued')?.description,
      'Next up',
    )
    const hydra = optimisticState({
      state: described,
      edit: {
        name: 'hydra',
        args: [
          'set',
          '--done-after-hours',
          '48',
        ],
      },
    })
    assert.equal(
      hydra.config?.doneAfterHours,
      48,
    )
    assert.equal(
      original.config?.doneAfterHours,
      undefined,
    )
    const reminded = optimisticState({
      state: original,
      edit: {
        name: 'task',
        args: [
          'remind',
          'one',
          '2027-01-01T12:00:00Z',
          '--event-id',
          'reminder',
        ],
      },
    })
    assert.deepEqual(
      reminded.cards.one?.reminder,
      {
        id: 'reminder',
        at: '2027-01-01T12:00:00Z',
      },
    )
    assert.equal(
      optimisticState({
        state: reminded,
        edit: {
          name: 'task',
          args: [
            'remind',
            'one',
            'clear',
          ],
        },
      }).cards.one?.reminder,
      undefined,
    )
  },
)

test(
  'queued writes use the acknowledged revision while reads stay unchanged',
  () => {
    const state = {
      ...fixture(),
      viewRevision: 7,
      configRevision: 3,
    }
    assert.deepEqual(
      currentRevision({
        state,
        edit: {
          name: 'view',
          args: [
            'set',
            '--if-revision',
            '0',
          ],
        },
      }),
      [
        'set',
        '--if-revision',
        '7',
      ],
    )
    assert.deepEqual(
      currentRevision({
        state,
        edit: {
          name: 'column',
          args: [
            'rename',
            'queued',
            '--if-revision',
            '0',
          ],
        },
      }),
      [
        'rename',
        'queued',
        '--if-revision',
        '3',
      ],
    )
    assert.deepEqual(
      currentRevision({
        state,
        edit: {
          name: 'move',
          args: [
            'one',
            'parked',
            '--if-revision',
            '0',
          ],
        },
      }),
      [
        'one',
        'parked',
        '--if-revision',
        String(state.cards.one?.revision),
      ],
    )
    assert.equal(
      optimisticState({
        state,
        edit: {
          name: 'thread',
          args: ['one'],
        },
      }),
      state,
    )
    assert.throws(() => optimisticState({
      state,
      edit: {
        name: 'view',
        args: [
          'set',
          '--json',
          '{"cardHeight":-1}',
        ],
      },
    }))
  },
)

test(
  'edits can target a column whose creation is still pending',
  () => {
    const state = fixture()
    const created = projectEdits({
      state,
      edits: [
        {
          name: 'column',
          args: [
            'create',
            '--id',
            'custom:research',
            '--title',
            'New column',
          ],
        },
      ],
    })
    const renamed = optimisticState({
      state: created,
      edit: {
        name: 'column',
        args: [
          'rename',
          'custom:research',
          '--title',
          'Research',
        ],
      },
    })
    assert.notEqual(
      renamed,
      created,
    )
    assert.equal(
      renamed.config?.columns.at(-1)?.title,
      'Research',
    )
    assert.ok(!state.config?.columns.some(c => c.id === 'custom:research'))
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
