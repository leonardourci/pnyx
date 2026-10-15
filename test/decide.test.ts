import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideLink, decideMove, decideOutcome, decidePush, decideUndo, parseLink, type Decision, type Meta } from '../src/core/decide.ts'
import { BoardError, type BoardEvent, type BoardState } from '../src/core/model.ts'
import { emptyBoard, reduce } from '../src/core/reducer.ts'

const meta: Meta = { at: '2026-10-13T12:00:00Z', actor: 'test' }

function apply({ state, decision }: { state: BoardState; decision: Decision }): BoardState {
  assert.ok('event' in decision, `expected an event, got ${JSON.stringify(decision)}`)

  return reduce({ state, event: decision.event })
}

function eventOf({ decision }: { decision: Decision }): BoardEvent {
  assert.ok('event' in decision)

  return decision.event
}

const rejects = ({ fn, code }: { fn: () => unknown; code: string }) =>
  assert.throws(fn, (error: unknown) => error instanceof BoardError && error.code === code)

const source = ({ observedAt, generation = 1 }: { observedAt: string; generation?: unknown }) => ({ adapter: 'claude', objectId: 's1', generation, observedAt })

test('push upserts by key and repeats are no-ops', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'k1', input: { title: 'One', source: source({ observedAt: '2026-10-13T10:00:00Z' }) }, meta }) })
  assert.equal(state.keys.k1, 'c1')
  assert.deepEqual(decidePush({ state, key: 'k1', input: { title: 'One', source: source({ observedAt: '2026-10-13T10:00:00Z' }) }, meta }), { skipped: 'unchanged' })
  state = apply({ state, decision: decidePush({ state, key: 'k1', input: { title: 'One, renamed' }, meta }) })
  assert.equal(Object.keys(state.cards).length, 1)
  assert.equal(state.cards.c1!.title, 'One, renamed')
})

test('push skips a repeated event id and an older observation', () => {
  const state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'k1', input: { source: source({ observedAt: '2026-10-13T10:00:00Z', generation: 2 }) }, meta: { ...meta, id: 'hook-1' } }) })
  assert.deepEqual(decidePush({ state, key: 'k1', input: { title: 'x' }, meta: { ...meta, id: 'hook-1' } }), { skipped: 'duplicate' })
  assert.deepEqual(decidePush({ state, key: 'k1', input: { source: source({ observedAt: '2026-10-13T09:00:00Z', generation: 2 }) }, meta }), { skipped: 'stale' })
  assert.deepEqual(decidePush({ state, key: 'k1', input: { source: source({ observedAt: '2026-10-13T11:00:00Z', generation: 1 }) }, meta }), { skipped: 'stale' })
})

test('push validates its input', () => {
  rejects({ fn: () => decidePush({ state: emptyBoard(), key: 'k1', input: { titel: 'typo' }, meta }), code: 'VALIDATION_ERROR' })
  rejects({ fn: () => decidePush({ state: emptyBoard(), key: 'k1', input: { tags: 'a' }, meta }), code: 'VALIDATION_ERROR' })
  rejects({ fn: () => decidePush({ state: emptyBoard(), key: 'k1', input: { attention: [{ kind: 'q' }] }, meta }), code: 'VALIDATION_ERROR' })
  rejects({ fn: () => decidePush({ state: emptyBoard(), key: 'k1', input: { parent: 'missing' }, meta }), code: 'NOT_FOUND' })
  rejects({ fn: () => decidePush({ state: emptyBoard(), key: '', input: {}, meta }), code: 'VALIDATION_ERROR' })
})

test('push resolves the parent by key and rejects cycles', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'parent', input: {}, meta }) })
  state = apply({ state, decision: decidePush({ state, key: 'child', input: { parent: 'parent' }, meta }) })
  assert.equal(state.cards.c2!.parentId, 'c1')
  rejects({ fn: () => decidePush({ state, key: 'parent', input: { parent: 'child' }, meta }), code: 'VALIDATION_ERROR' })
  state = apply({ state, decision: decidePush({ state, key: 'child', input: { parent: null }, meta }) })
  assert.equal(state.cards.c2!.parentId, undefined)
})

test('parseLink fills GitHub pull request details and validates', () => {
  assert.deepEqual(parseLink({ input: { url: 'https://github.com/o/r/pull/12', state: 'open' } }), {
    kind: 'github_pr',
    url: 'https://github.com/o/r/pull/12',
    number: 12,
    state: 'open',
  })
  assert.equal(parseLink({ input: { url: 'https://example.com/doc' } }).kind, 'url')
  rejects({ fn: () => parseLink({ input: { url: 'javascript:alert(1)' } }), code: 'VALIDATION_ERROR' })
  rejects({ fn: () => parseLink({ input: { url: 'https://github.com/o/r/pull/1', state: 'draft' } }), code: 'VALIDATION_ERROR' })
})

test('undo reverses a move unless the card changed since', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'k1', input: {}, meta }) })
  const move = eventOf({ decision: decideMove({ state, ref: 'c1', column: 'parked', meta }) })
  state = reduce({ state, event: move })
  const undo = eventOf({ decision: decideUndo({ state, target: move, meta }) })
  assert.equal(undo.undoes, move.id)
  assert.equal(reduce({ state, event: undo }).cards.c1!.manualColumn, undefined)

  const later = reduce({ state, event: eventOf({ decision: decideMove({ state, ref: 'c1', column: 'done', meta }) }) })
  rejects({ fn: () => decideUndo({ state: later, target: move, meta }), code: 'CONFLICT' })
  rejects({ fn: () => decideUndo({ state, target: move, meta: { ...meta, ifRevision: 99 } }), code: 'REVISION_CONFLICT' })
  const undone = reduce({ state, event: undo })
  rejects({ fn: () => decideUndo({ state: undone, target: move, meta }), code: 'CONFLICT' })
})

test('undo reverses a link update but never a merge', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'k1', input: {}, meta }) })
  const url = 'https://github.com/o/r/pull/3'
  const open = eventOf({ decision: decideLink({ state, ref: 'c1', url, link: parseLink({ input: { url, state: 'open' } }), meta }) })
  state = reduce({ state, event: open })
  assert.equal(state.cards.c1!.column, 'parked')
  const reverted = reduce({
    state,
    event: eventOf({ decision: decideUndo({ state, target: open, meta }) }),
  })
  assert.deepEqual(reverted.cards.c1!.links, [])

  const merged = eventOf({ decision: decideLink({ state, ref: 'c1', url, link: { kind: 'github_pr', url, state: 'merged' }, meta }) })
  state = reduce({ state, event: merged })
  assert.equal(state.cards.c1!.column, 'done')
  rejects({ fn: () => decideUndo({ state, target: merged, meta }), code: 'NOT_UNDOABLE' })
})

test('undo reverses a manual push edit, but not creation or source observations', () => {
  const created = eventOf({ decision: decidePush({ state: emptyBoard(), key: 'k1', input: { title: 'One' }, meta }) })
  let state = reduce({ state: emptyBoard(), event: created })
  rejects({ fn: () => decideUndo({ state, target: created, meta }), code: 'NOT_UNDOABLE' })

  const edit = eventOf({ decision: decidePush({ state, key: 'k1', input: { title: 'Two', activity: 'busy', tags: ['a'] }, meta }) })
  assert.deepEqual(edit.type === 'card.pushed' && edit.data.before, { title: 'One', activity: null, tags: [] })
  state = reduce({ state, event: edit })
  const undo = eventOf({ decision: decideUndo({ state, target: edit, meta }) })
  const undone = reduce({ state, event: undo })
  assert.equal(undone.cards.c1!.title, 'One')
  assert.equal(undone.cards.c1!.activity, undefined)
  assert.deepEqual(undone.cards.c1!.tags, [])
  // Undoing the undo redoes the edit.
  assert.equal(reduce({ state: undone, event: eventOf({ decision: decideUndo({ state: undone, target: undo, meta }) }) }).cards.c1!.title, 'Two')

  const observed = eventOf({ decision: decidePush({ state, key: 'k1', input: { activity: 'idle', source: source({ observedAt: '2026-10-13T10:00:00Z' }) }, meta }) })
  rejects({ fn: () => decideUndo({ state: reduce({ state, event: observed }), target: observed, meta }), code: 'NOT_UNDOABLE' })
})

test('an undone undo points at the latest event in the chain', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'k1', input: {}, meta }) })
  const move = eventOf({ decision: decideMove({ state, ref: 'c1', column: 'done', meta }) })
  state = reduce({ state, event: move })
  const undo = eventOf({ decision: decideUndo({ state, target: move, meta }) })
  state = reduce({ state, event: undo })
  const redo = eventOf({ decision: decideUndo({ state, target: undo, meta }) })
  state = reduce({ state, event: redo })
  assert.equal(state.cards.c1!.manualColumn, 'done')
  assert.throws(
    () => decideUndo({ state, target: move, meta }),
    (error: unknown) => error instanceof BoardError && error.code === 'CONFLICT' && error.help[0]!.includes(`undo ${redo.id}`),
  )
})

test('every write checks the expected revision; a repeated event id wins over it', () => {
  const created = eventOf({ decision: decidePush({ state: emptyBoard(), key: 'k1', input: {}, meta: { ...meta, ifRevision: 0 } }) })
  const state = reduce({ state: emptyBoard(), event: created })
  const stale = { ...meta, ifRevision: 0 }
  rejects({ fn: () => decidePush({ state, key: 'k1', input: { title: 'x' }, meta: stale }), code: 'REVISION_CONFLICT' })
  rejects({ fn: () => decideMove({ state, ref: 'c1', column: 'done', meta: stale }), code: 'REVISION_CONFLICT' })
  rejects({ fn: () => decideLink({ state, ref: 'c1', url: 'https://example.com', link: parseLink({ input: { url: 'https://example.com' } }), meta: stale }), code: 'REVISION_CONFLICT' })
  rejects({ fn: () => decideOutcome({ state, ref: 'c1', outcome: { state: 'done' }, meta: stale }), code: 'REVISION_CONFLICT' })
  assert.ok('event' in decideOutcome({ state, ref: 'c1', outcome: { state: 'done' }, meta: { ...meta, ifRevision: 1 } }))
  assert.deepEqual(decidePush({ state, key: 'k1', input: { title: 'x' }, meta: { ...stale, id: created.id } }), { skipped: 'duplicate' })
})

test('generated event ids never collide with caller-chosen ones', () => {
  let state = apply({ state: emptyBoard(), decision: decidePush({ state: emptyBoard(), key: 'a', input: {}, meta: { ...meta, id: 'evt_3' } }) })
  state = apply({ state, decision: decidePush({ state, key: 'b', input: {}, meta }) })
  const third = eventOf({ decision: decidePush({ state, key: 'c', input: {}, meta }) })
  assert.equal(third.seq, 3)
  assert.notEqual(third.id, 'evt_3')
  assert.ok(reduce({ state, event: third }).cards[third.cardId])
})
