import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideUndo } from '../src/app/undo.ts'
import type { Decision, HydraEvent, HydraState } from '../src/app/model.ts'
import type { Meta } from '../src/app/command-meta.ts'
import { decideLink, decideMove, decideOutcome, decidePush, parseLink } from '../src/core/decide.ts'
import { HydraError } from '../src/store/errors.ts'
import { emptyHydra, reduce } from '../src/app/reducer.ts'
import { columnCards } from '../src/core/tasks.ts'

const meta: Meta = {
  at: '2026-10-13T12:00:00Z',
  actor: 'test',
}

function apply({
  state,
  decision,
}: {
  state: HydraState
  decision: Decision
}): HydraState {
  assert.ok(
    'event' in decision,
    `expected an event, got ${JSON.stringify(decision)}`,
  )

  return reduce({
    state,
    event: decision.event,
  })
}

function eventOf({ decision }: { decision: Decision }): HydraEvent {
  assert.ok('event' in decision)

  return decision.event
}

const rejects = ({
  fn,
  code,
}: {
  fn: () => unknown
  code: string
}) =>
  assert.throws(
    fn,
    (error: unknown) => error instanceof HydraError && error.code === code,
  )

const source = ({
  observedAt,
  generation = 1,
}: {
  observedAt: string
  generation?: unknown
}) => ({
  adapter: 'claude',
  objectId: 's1',
  generation,
  observedAt,
})

test(
  'push skips a repeated event id and an older observation',
  () => {
    const state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k1',
        input: {
          source: source({
            observedAt: '2026-10-13T10:00:00Z',
            generation: 2,
          }),
        },
        meta: {
          ...meta,
          id: 'hook-1',
        },
      }),
    })
    assert.deepEqual(
      decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: { title: 'x' },
        meta: {
          ...meta,
          id: 'hook-1',
        },
      }),
      { skipped: 'duplicate' },
    )
    assert.deepEqual(
      decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: {
          source: source({
            observedAt: '2026-10-13T09:00:00Z',
            generation: 2,
          }),
        },
        meta,
      }),
      { skipped: 'stale' },
    )
    assert.deepEqual(
      decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: {
          source: source({
            observedAt: '2026-10-13T11:00:00Z',
            generation: 1,
          }),
        },
        meta,
      }),
      { skipped: 'stale' },
    )
  },
)

test(
  'push resolves the parent by key and rejects cycles',
  () => {
    let state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'parent',
        input: {},
        meta,
      }),
    })
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'child',
        input: { parent: 'parent' },
        meta,
      }),
    })
    assert.equal(
      state.cards.c2!.parentId,
      'c1',
    )
    rejects({
      fn: () => decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'parent',
        input: { parent: 'child' },
        meta,
      }),
      code: 'VALIDATION_ERROR',
    })
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'child',
        input: { parent: null },
        meta,
      }),
    })
    assert.equal(
      state.cards.c2!.parentId,
      undefined,
    )
  },
)

test(
  'parseLink fills GitHub pull request details and validates',
  () => {
    assert.deepEqual(
      parseLink({
        input: {
          url: 'https://github.com/o/r/pull/12',
          state: 'open',
        },
      }),
      {
        kind: 'github_pr',
        url: 'https://github.com/o/r/pull/12',
        number: 12,
        state: 'open',
      },
    )
    assert.equal(
      parseLink({ input: { url: 'https://example.com/doc' } }).kind,
      'url',
    )
    rejects({
      fn: () => parseLink({ input: { url: 'javascript:alert(1)' } }),
      code: 'VALIDATION_ERROR',
    })
    rejects({
      fn: () => parseLink({
        input: {
          url: 'https://github.com/o/r/pull/1',
          state: 'draft',
        },
      }),
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'undo reverses a move unless the card changed since',
  () => {
    let state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k1',
        input: {},
        meta,
      }),
    })
    const move = eventOf({
      decision: decideMove({
        state,
        ref: 'c1',
        column: 'parked',
        meta,
      }),
    })
    state = reduce({
      state,
      event: move,
    })
    const undo = eventOf({
      decision: decideUndo({
        state,
        target: move,
        meta,
      }),
    })
    assert.equal(
      undo.undoes,
      move.id,
    )
    assert.equal(
      reduce({
        state,
        event: undo,
      }).cards.c1!.column,
      'in_progress',
    )

    const later = reduce({
      state,
      event: eventOf({
        decision: decideMove({
          state,
          ref: 'c1',
          column: 'done',
          meta,
        }),
      }),
    })
    rejects({
      fn: () => decideUndo({
        state: later,
        target: move,
        meta,
      }),
      code: 'CONFLICT',
    })
    rejects({
      fn: () => decideUndo({
        state,
        target: move,
        meta: {
          ...meta,
          ifRevision: 99,
        },
      }),
      code: 'REVISION_CONFLICT',
    })
    const undone = reduce({
      state,
      event: undo,
    })
    rejects({
      fn: () => decideUndo({
        state: undone,
        target: move,
        meta,
      }),
      code: 'CONFLICT',
    })
  },
)

test(
  'a move orders the card within its column, and nothing else reorders it',
  () => {
    let state = emptyHydra()

    for (const key of [
      'a',
      'b',
      'c',
    ]) {
      state = apply({
        state,
        decision: decidePush({
          state,
          newCardId: `c${state.seq + 1}`,
          key,
          input: {},
          meta,
        }),
      })
    }

    const order = () => columnCards({
      state,
      column: 'in_progress',
    }).map(c => c.key)
    assert.deepEqual(
      order(),
      [
        'a',
        'b',
        'c',
      ],
      'new cards go to the end',
    )

    const top = eventOf({
      decision: decideMove({
        state,
        ref: 'c',
        column: 'in_progress',
        before: 'a',
        meta,
      }),
    })
    state = reduce({
      state,
      event: top,
    })
    assert.deepEqual(
      order(),
      [
        'c',
        'a',
        'b',
      ],
    )
    const between = eventOf({
      decision: decideMove({
        state,
        ref: 'b',
        column: 'in_progress',
        before: 'a',
        meta,
      }),
    })
    state = reduce({
      state,
      event: between,
    })
    assert.deepEqual(
      order(),
      [
        'c',
        'b',
        'a',
      ],
      'between two cards',
    )
    const undo = eventOf({
      decision: decideUndo({
        state,
        target: between,
        meta,
      }),
    })
    state = reduce({
      state,
      event: undo,
    })
    assert.deepEqual(
      order(),
      [
        'c',
        'a',
        'b',
      ],
      'undo restores the old position',
    )
    state = apply({
      state,
      decision: decideMove({
        state,
        ref: 'c',
        column: 'in_progress',
        meta,
      }),
    })
    assert.deepEqual(
      order(),
      [
        'a',
        'b',
        'c',
      ],
      'no --before goes to the end',
    )
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'a',
        input: {
          title: 'edited',
          activity: 'working',
        },
        meta,
      }),
    })
    assert.deepEqual(
      order(),
      [
        'a',
        'b',
        'c',
      ],
      'an edit never reorders',
    )

    state = apply({
      state,
      decision: decideMove({
        state,
        ref: 'a',
        column: 'done',
        meta,
      }),
    })
    rejects({
      fn: () => decideMove({
        state,
        ref: 'b',
        column: 'in_progress',
        before: 'a',
        meta,
      }),
      code: 'VALIDATION_ERROR',
    })
    rejects({
      fn: () => decideMove({
        state,
        ref: 'b',
        column: 'in_progress',
        before: 'b',
        meta,
      }),
      code: 'VALIDATION_ERROR',
    })
    rejects({
      fn: () => decideMove({
        state,
        ref: 'b',
        column: 'custom:nowhere',
        meta,
      }),
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'undo restores every field a manual push edit changed',
  () => {
    const created = eventOf({
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k1',
        input: { title: 'One' },
        meta,
      }),
    })
    let state = reduce({
      state: emptyHydra(),
      event: created,
    })

    const edit = eventOf({
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: {
          title: 'Two',
          activity: 'busy',
          tags: ['a'],
        },
        meta,
      }),
    })
    state = reduce({
      state,
      event: edit,
    })
    const undo = eventOf({
      decision: decideUndo({
        state,
        target: edit,
        meta,
      }),
    })
    const undone = reduce({
      state,
      event: undo,
    })
    assert.equal(
      undone.cards.c1!.title,
      'One',
    )
    assert.equal(
      undone.cards.c1!.activity,
      undefined,
    )
    assert.deepEqual(
      undone.cards.c1!.tags,
      [],
    )
  },
)

test(
  'an undone undo points at the latest event in the chain',
  () => {
    let state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k1',
        input: {},
        meta,
      }),
    })
    const move = eventOf({
      decision: decideMove({
        state,
        ref: 'c1',
        column: 'done',
        meta,
      }),
    })
    state = reduce({
      state,
      event: move,
    })
    const undo = eventOf({
      decision: decideUndo({
        state,
        target: move,
        meta,
      }),
    })
    state = reduce({
      state,
      event: undo,
    })
    const redo = eventOf({
      decision: decideUndo({
        state,
        target: undo,
        meta,
      }),
    })
    state = reduce({
      state,
      event: redo,
    })
    assert.equal(
      state.cards.c1!.column,
      'done',
    )
    assert.throws(
      () => decideUndo({
        state,
        target: move,
        meta,
      }),
      (error: unknown) => error instanceof HydraError && error.code === 'CONFLICT' && error.help[0]!.includes(`undo ${redo.id}`),
    )
  },
)

test(
  'every write checks the expected revision; a repeated event id wins over it',
  () => {
    const created = eventOf({
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'k1',
        input: {},
        meta: {
          ...meta,
          ifRevision: 0,
        },
      }),
    })
    const state = reduce({
      state: emptyHydra(),
      event: created,
    })
    const stale = {
      ...meta,
      ifRevision: 0,
    }
    rejects({
      fn: () => decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: { title: 'x' },
        meta: stale,
      }),
      code: 'REVISION_CONFLICT',
    })
    rejects({
      fn: () => decideMove({
        state,
        ref: 'c1',
        column: 'done',
        meta: stale,
      }),
      code: 'REVISION_CONFLICT',
    })
    rejects({
      fn: () => decideLink({
        state,
        ref: 'c1',
        url: 'https://example.com',
        link: parseLink({ input: { url: 'https://example.com' } }),
        meta: stale,
      }),
      code: 'REVISION_CONFLICT',
    })
    rejects({
      fn: () => decideOutcome({
        state,
        ref: 'c1',
        outcome: { state: 'done' },
        meta: stale,
      }),
      code: 'REVISION_CONFLICT',
    })
    assert.ok('event' in decideOutcome({
      state,
      ref: 'c1',
      outcome: { state: 'done' },
      meta: {
        ...meta,
        ifRevision: 1,
      },
    }))
    assert.deepEqual(
      decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'k1',
        input: { title: 'x' },
        meta: {
          ...stale,
          id: created.id,
        },
      }),
      { skipped: 'duplicate' },
    )
  },
)

test(
  'generated event ids never collide with caller-chosen ones',
  () => {
    let state = apply({
      state: emptyHydra(),
      decision: decidePush({
        state: emptyHydra(),
        newCardId: `c${emptyHydra().seq + 1}`,
        key: 'a',
        input: {},
        meta: {
          ...meta,
          id: 'evt_3',
        },
      }),
    })
    state = apply({
      state,
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'b',
        input: {},
        meta,
      }),
    })
    const third = eventOf({
      decision: decidePush({
        state,
        newCardId: `c${state.seq + 1}`,
        key: 'c',
        input: {},
        meta,
      }),
    })
    assert.equal(
      third.seq,
      3,
    )
    assert.equal(
      third.id,
      'evt_3_2',
    )
    assert.ok(reduce({
      state,
      event: third,
    }).cards[third.cardId])
  },
)
