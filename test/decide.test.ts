import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideLink, decideMove, decideOutcome, decidePush, decideUndo, parseLink, type Decision, type Meta } from '../src/core/decide.ts'
import { BoardError, type BoardEvent, type BoardState } from '../src/core/model.ts'
import { emptyBoard, reduce } from '../src/core/reducer.ts'

const meta: Meta = { at: '2026-10-13T12:00:00Z', actor: 'test' }

function apply(state: BoardState, decision: Decision): BoardState {
  assert.ok('event' in decision, `expected an event, got ${JSON.stringify(decision)}`)

  return reduce(state, decision.event)
}

function eventOf(decision: Decision): BoardEvent {
  assert.ok('event' in decision)

  return decision.event
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof BoardError && error.code === code)

const source = (observedAt: string, generation = 1) => ({ adapter: 'claude', objectId: 's1', generation, observedAt })

test('push upserts by key and repeats are no-ops', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'k1', { title: 'One', source: source('2026-10-13T10:00:00Z') }, meta))
  assert.equal(state.keys.k1, 'c1')
  assert.deepEqual(decidePush(state, 'k1', { title: 'One', source: source('2026-10-13T10:00:00Z') }, meta), { skipped: 'unchanged' })
  state = apply(state, decidePush(state, 'k1', { title: 'One, renamed' }, meta))
  assert.equal(Object.keys(state.cards).length, 1)
  assert.equal(state.cards.c1!.title, 'One, renamed')
})

test('push skips a repeated event id and an older observation', () => {
  const state = apply(emptyBoard(), decidePush(emptyBoard(), 'k1', { source: source('2026-10-13T10:00:00Z', 2) }, { ...meta, id: 'hook-1' }))
  assert.deepEqual(decidePush(state, 'k1', { title: 'x' }, { ...meta, id: 'hook-1' }), { skipped: 'duplicate' })
  assert.deepEqual(decidePush(state, 'k1', { source: source('2026-10-13T09:00:00Z', 2) }, meta), { skipped: 'stale' })
  assert.deepEqual(decidePush(state, 'k1', { source: source('2026-10-13T11:00:00Z', 1) }, meta), { skipped: 'stale' })
})

test('push validates its input', () => {
  rejects(() => decidePush(emptyBoard(), 'k1', { titel: 'typo' }, meta), 'VALIDATION_ERROR')
  rejects(() => decidePush(emptyBoard(), 'k1', { tags: 'a' }, meta), 'VALIDATION_ERROR')
  rejects(() => decidePush(emptyBoard(), 'k1', { attention: [{ kind: 'q' }] }, meta), 'VALIDATION_ERROR')
  rejects(() => decidePush(emptyBoard(), 'k1', { parent: 'missing' }, meta), 'NOT_FOUND')
  rejects(() => decidePush(emptyBoard(), '', {}, meta), 'VALIDATION_ERROR')
})

test('push resolves the parent by key and rejects cycles', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'parent', {}, meta))
  state = apply(state, decidePush(state, 'child', { parent: 'parent' }, meta))
  assert.equal(state.cards.c2!.parentId, 'c1')
  rejects(() => decidePush(state, 'parent', { parent: 'child' }, meta), 'VALIDATION_ERROR')
  state = apply(state, decidePush(state, 'child', { parent: null }, meta))
  assert.equal(state.cards.c2!.parentId, undefined)
})

test('parseLink fills GitHub pull request details and validates', () => {
  assert.deepEqual(parseLink({ url: 'https://github.com/o/r/pull/12', state: 'open' }), {
    kind: 'github_pr',
    url: 'https://github.com/o/r/pull/12',
    number: 12,
    state: 'open',
  })
  assert.equal(parseLink({ url: 'https://example.com/doc' }).kind, 'url')
  rejects(() => parseLink({ url: 'javascript:alert(1)' }), 'VALIDATION_ERROR')
  rejects(() => parseLink({ url: 'https://github.com/o/r/pull/1', state: 'draft' }), 'VALIDATION_ERROR')
})

test('undo reverses a move unless the card changed since', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'k1', {}, meta))
  const move = eventOf(decideMove(state, 'c1', 'review', meta))
  state = reduce(state, move)
  const undo = eventOf(decideUndo(state, move, meta))
  assert.equal(undo.undoes, move.id)
  assert.equal(reduce(state, undo).cards.c1!.manualColumn, undefined)

  const later = reduce(state, eventOf(decideMove(state, 'c1', 'done', meta)))
  rejects(() => decideUndo(later, move, meta), 'CONFLICT')
  rejects(() => decideUndo(state, move, { ...meta, ifRevision: 99 }), 'REVISION_CONFLICT')
  const undone = reduce(state, undo)
  rejects(() => decideUndo(undone, move, meta), 'CONFLICT')
})

test('undo reverses a link update but never a merge', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'k1', {}, meta))
  const url = 'https://github.com/o/r/pull/3'
  const open = eventOf(decideLink(state, 'c1', url, parseLink({ url, state: 'open' }), meta))
  state = reduce(state, open)
  assert.equal(state.cards.c1!.column, 'review')
  const reverted = reduce(state, eventOf(decideUndo(state, open, meta)))
  assert.deepEqual(reverted.cards.c1!.links, [])

  const merged = eventOf(decideLink(state, 'c1', url, { kind: 'github_pr', url, state: 'merged' }, meta))
  state = reduce(state, merged)
  assert.equal(state.cards.c1!.column, 'done')
  rejects(() => decideUndo(state, merged, meta), 'NOT_UNDOABLE')
})

test('undo reverses a manual push edit, but not creation or source observations', () => {
  const created = eventOf(decidePush(emptyBoard(), 'k1', { title: 'One' }, meta))
  let state = reduce(emptyBoard(), created)
  rejects(() => decideUndo(state, created, meta), 'NOT_UNDOABLE')

  const edit = eventOf(decidePush(state, 'k1', { title: 'Two', activity: 'busy', tags: ['a'] }, meta))
  assert.deepEqual(edit.type === 'card.pushed' && edit.data.before, { title: 'One', activity: null, tags: [] })
  state = reduce(state, edit)
  const undo = eventOf(decideUndo(state, edit, meta))
  const undone = reduce(state, undo)
  assert.equal(undone.cards.c1!.title, 'One')
  assert.equal(undone.cards.c1!.activity, undefined)
  assert.deepEqual(undone.cards.c1!.tags, [])
  // Undoing the undo redoes the edit.
  assert.equal(reduce(undone, eventOf(decideUndo(undone, undo, meta))).cards.c1!.title, 'Two')

  const observed = eventOf(decidePush(state, 'k1', { activity: 'idle', source: source('2026-10-13T10:00:00Z') }, meta))
  rejects(() => decideUndo(reduce(state, observed), observed, meta), 'NOT_UNDOABLE')
})

test('an undone undo points at the latest event in the chain', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'k1', {}, meta))
  const move = eventOf(decideMove(state, 'c1', 'done', meta))
  state = reduce(state, move)
  const undo = eventOf(decideUndo(state, move, meta))
  state = reduce(state, undo)
  const redo = eventOf(decideUndo(state, undo, meta))
  state = reduce(state, redo)
  assert.equal(state.cards.c1!.manualColumn, 'done')
  assert.throws(
    () => decideUndo(state, move, meta),
    (error: unknown) => error instanceof BoardError && error.code === 'CONFLICT' && error.help[0]!.includes(`undo ${redo.id}`),
  )
})

test('every write checks the expected revision; a repeated event id wins over it', () => {
  const created = eventOf(decidePush(emptyBoard(), 'k1', {}, { ...meta, ifRevision: 0 }))
  const state = reduce(emptyBoard(), created)
  const stale = { ...meta, ifRevision: 0 }
  rejects(() => decidePush(state, 'k1', { title: 'x' }, stale), 'REVISION_CONFLICT')
  rejects(() => decideMove(state, 'c1', 'done', stale), 'REVISION_CONFLICT')
  rejects(() => decideLink(state, 'c1', 'https://example.com', parseLink({ url: 'https://example.com' }), stale), 'REVISION_CONFLICT')
  rejects(() => decideOutcome(state, 'c1', { state: 'done' }, stale), 'REVISION_CONFLICT')
  assert.ok('event' in decideOutcome(state, 'c1', { state: 'done' }, { ...meta, ifRevision: 1 }))
  assert.deepEqual(decidePush(state, 'k1', { title: 'x' }, { ...stale, id: created.id }), { skipped: 'duplicate' })
})

test('generated event ids never collide with caller-chosen ones', () => {
  let state = apply(emptyBoard(), decidePush(emptyBoard(), 'a', {}, { ...meta, id: 'evt_3' }))
  state = apply(state, decidePush(state, 'b', {}, meta))
  const third = eventOf(decidePush(state, 'c', {}, meta))
  assert.equal(third.seq, 3)
  assert.notEqual(third.id, 'evt_3')
  assert.ok(reduce(state, third).cards[third.cardId])
})
