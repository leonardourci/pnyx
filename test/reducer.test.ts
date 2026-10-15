import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '../src/core/model.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { assertGolden, readStream } from './streams.ts'

for (const name of ['lifecycle', 'duplicates', 'pinned-attention', 'undo']) {
  test(`golden replay: ${name}`, () => {
    assertGolden({
      name,
      actual: replay({ state: emptyHydra(), events: readStream({ name }) }),
    })
  })
}

test('lifecycle: pull requests, merges and outcomes never move a card', () => {
  const events = readStream({ name: 'lifecycle' })

  for (let seq = 1; seq <= events.length; seq++) {
    const state = replay({ state: emptyHydra(), events: events.slice(0, seq) })
    assert.equal(state.cards.c1!.column, 'workers_on_it', `after event ${seq}`)
  }

  const end = replay({ state: emptyHydra(), events })
  assert.equal(end.cards.c2!.parentId, 'c1')
  assert.equal(end.cards.c2!.column, 'workers_on_it')
  assert.equal(end.cards.c1!.links.filter(l => l.state === 'merged').length, 2)
})

test('duplicates and out-of-order observations are ignored', () => {
  const state = replay({ state: emptyHydra(), events: readStream({ name: 'duplicates' }) })
  const card = state.cards.c1!
  assert.equal(state.seq, 9)
  assert.equal(card.title, 'Refactor store layer')
  assert.equal(card.activity, 'working')
  assert.equal(card.links[0]!.state, 'merged')
  assert.equal(card.column, 'workers_on_it')
  assert.equal(state.eventIds['hook-0001'], 1)
  assert.equal(state.eventIds['hook-late'], undefined)
  // Applied: hook-0001, hook-0002, evt_7, hook-0005.
  assert.equal(card.revision, 4)
})

test('a moved card keeps its column and shows new attention; a legacy return to auto leaves it', () => {
  const state = replay({ state: emptyHydra(), events: readStream({ name: 'pinned-attention' }) })
  const card = state.cards.c1!
  // review is no longer a Hydra column, so the card falls back to Parked.
  assert.equal(card.column, 'parked')
  assert.deepEqual(card.attention.map(a => a.kind), ['permission_needed'])

  const auto: HydraEvent = {
    v: 1,
    seq: 4,
    id: 'evt_4',
    at: '2026-10-13T13:04:00Z',
    actor: 'cli',
    cardId: 'c1',
    type: 'card.moved',
    data: { before: 'review', after: null },
  }
  assert.equal(reduce({ state, event: auto }).cards.c1!.column, 'parked')
})

test('undo events restore the card and record what they reversed', () => {
  const state = replay({ state: emptyHydra(), events: readStream({ name: 'undo' }) })
  const card = state.cards.c1!
  assert.deepEqual(card.links, [])
  assert.equal(card.outcome, undefined)
  assert.equal(card.column, 'workers_on_it')
  assert.deepEqual(state.undone, { evt_2: 'evt_3', evt_4: 'evt_5', evt_6: 'evt_7' })
})

test('replay is pure and deterministic', () => {
  const events = readStream({ name: 'lifecycle' })
  const start = emptyHydra()
  const frozen = structuredClone(start)
  const once = replay({ state: start, events })
  assert.deepEqual(start, frozen)
  assert.deepEqual(replay({
    state: replay({
      state: start,
      events: events.slice(0, 4),
    }),
    events: events.slice(4),
  }), once)
  assert.deepEqual(replay({ state: emptyHydra(), events }), once)
})

test('a parent change that would make a cycle is ignored', () => {
  const events = readStream({ name: 'lifecycle' })
  const cycle: HydraEvent = {
    v: 1,
    seq: 9,
    id: 'evt_9',
    at: '2026-10-13T10:09:00Z',
    actor: 'cli',
    cardId: 'c1',
    type: 'card.pushed',
    data: { key: 'claude:host-a:sess-1', parentId: 'c2' },
  }
  assert.equal(replay({
    state: emptyHydra(),
    events: [...events, cycle],
  }).cards.c1!.parentId, undefined)
})

test('an auto title fills an untitled card, best source first, and never replaces a set title', () => {
  let state = emptyHydra()

  const apply = ({ type, data }: { type: string; data: object }) => {
    const seq = state.seq + 1
    state = reduce({ state, event: { v: 1, seq, id: `e${seq}`, at: '2026-10-13T00:00:00Z', actor: 'test', cardId: 'c1', type, data } as HydraEvent })

    return state.cards.c1!.title
  }

  const push = ({ fields }: { fields: object }) => apply({ type: 'card.pushed', data: { key: 'claude:s1', ...fields } })
  const sessionTitle = ({ title }: { title: string }) => apply({ type: 'card.noted', data: { kind: 'context', source: 'claude-code', text: `Session title: ${title}` } })

  assert.equal(push({ fields: {} }), 'claude:s1')
  assert.equal(push({ fields: { autoTitle: { from: 'folder', text: 'repo' } } }), 'repo')
  assert.equal(push({ fields: { autoTitle: { from: 'prompt', text: 'Fix the login bug' } } }), 'Fix the login bug')
  assert.equal(push({ fields: { autoTitle: { from: 'prompt', text: 'And add a test' } } }), 'Fix the login bug', 'the first prompt stays')
  assert.equal(push({ fields: { autoTitle: { from: 'folder', text: 'repo' } } }), 'Fix the login bug', 'a worse source never replaces a better one')
  assert.equal(sessionTitle({ title: 'Login bug' }), 'Login bug')
  assert.equal(sessionTitle({ title: 'Login bug and tests' }), 'Login bug and tests', 'a later session title wins')
  assert.equal(apply({ type: 'card.noted', data: { kind: 'context', source: 'firstmate', text: "Captain's intent: ship it" } }), 'Login bug and tests')
  assert.equal(push({ fields: { title: 'Mine' } }), 'Mine')
  assert.equal(sessionTitle({ title: 'Renamed' }), 'Mine', 'a set title is never replaced')
  assert.equal(push({ fields: { title: null } }), 'Renamed', 'undoing the set title returns to the auto title')
})
