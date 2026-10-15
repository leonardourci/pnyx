import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import type { Column, HydraChange, HydraEvent, HydraState } from '../src/core/model.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { DEFAULT_DONE_HOURS, doneDeadline, HOUR_MS } from '../src/core/retention.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hideDone } from '../src/store/retention.ts'

const start = '2026-10-14T12:00:00.000Z'
const later = '2026-10-15T12:00:00.000Z'

function fixture() {
  let state = emptyHydra()
  const events: HydraEvent[] = []

  const change = ({ type, data, at = start, cardId = 't1' }: Pick<HydraChange, 'type' | 'data'> & { at?: string; cardId?: string }) => {
    const decision = hydraEvent({ state, meta: { at, actor: 'test' }, cardId, change: { type, data } })
    assert.ok('event' in decision)
    events.push(decision.event)
    state = reduce({ state, event: decision.event })
  }

  change({ type: 'task.created', data: { key: 'work', title: 'Searchable completion', column: 'done' } })

  return { change, events, state: () => state }
}

test('Done time survives edits and reorders; leaving Done resets it and replay is deterministic', () => {
  const f = fixture()
  assert.equal(f.state().cards.t1?.doneAt, start)
  assert.equal(doneDeadline({ state: f.state() }), Date.parse(start) + DEFAULT_DONE_HOURS * HOUR_MS)
  f.change({ type: 'task.brief', data: { before: '', after: 'A later edit' }, at: later })
  assert.equal(f.state().cards.t1?.doneAt, start)

  const move = ({ column, at }: { column: Column; at: string }) => {
    const state = replay({ state: emptyHydra(), events: f.events })
    const event: HydraEvent = { v: 1, seq: state.seq + 1, id: `move-${state.seq}`, at, actor: 'test', cardId: 't1', type: 'card.moved', data: { before: state.cards.t1!.column, after: column } }
    f.events.push(event)

    return replay({ state: emptyHydra(), events: f.events })
  }

  assert.equal(move({ column: 'done', at: later }).cards.t1?.doneAt, start)
  const away = move({ column: 'parked', at: later })
  assert.equal(away.cards.t1?.doneAt, undefined)
  assert.equal(doneDeadline({ state: away }), undefined)
  assert.equal(move({ column: 'done', at: later }).cards.t1?.doneAt, later)
  const before = structuredClone(f.events)
  replay({ state: emptyHydra(), events: f.events })
  assert.deepEqual(f.events, before)
})

test('expiry appends hiding once, keeps history, restores on reopen, and honors settings and explicit restoration', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-retention-'))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home
  const hydraId = 'expiry'
  const path = join(home, 'hydras', hydraId, 'events.jsonl')
  const f = fixture()
  const append = ({ change, cardId = 't1', at = later }: { change: Pick<HydraChange, 'type' | 'data'>; cardId?: string; at?: string }) => withWriter({
    hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({ state: writer.state, meta: { at, actor: 'test' }, cardId, change })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })

  try {
    withWriter({ hydraId, fn: ({ writer }) => writer.append({ event: f.events[0]! }) })
    const original = readFileSync(path, 'utf8')
    assert.equal(hideDone({ hydraId, at: '2026-10-15T11:59:59.999Z' }), 0)
    assert.equal(hideDone({ hydraId, at: later }), 1)
    assert.equal(hideDone({ hydraId, at: later }), 0)
    let state = loadHydra({ hydraId }).state
    assert.equal(state.cards.t1?.hidden, true)
    assert.equal(state.cards.t1?.title, 'Searchable completion')
    assert.ok(readFileSync(path, 'utf8').startsWith(original))
    append({ change: { type: 'task.visibility', data: { before: true, after: false } } })
    assert.equal(hideDone({ hydraId, at: '2030-01-01T00:00:00Z' }), 0)
    assert.equal(loadHydra({ hydraId }).state.cards.t1?.keepDone, true)
    const moved: HydraEvent = { ...f.events[0]!, seq: loadHydra({ hydraId }).state.seq + 1, id: 'leave', at: later, type: 'card.moved', data: { before: 'done', after: 'parked' } }
    withWriter({ hydraId, fn: ({ writer }) => writer.append({ event: moved }) })
    assert.equal(loadHydra({ hydraId }).state.cards.t1?.keepDone, undefined)
    withWriter({ hydraId, fn: ({ writer }) => writer.append({ event: { ...moved, seq: writer.state.seq + 1, id: 'return', data: { before: 'parked', after: 'done' } } }) })
    const config = hydraConfig({ state: loadHydra({ hydraId }).state, id: hydraId })
    append({ cardId: '$board', change: { type: 'board.configured', data: { ...config, doneAfterHours: 0 } } })
    assert.equal(hideDone({ hydraId, at: '2030-01-01T00:00:00Z' }), 0)
    append({ cardId: '$board', change: { type: 'board.configured', data: { ...config, doneAfterHours: 1 } } })
    assert.equal(hideDone({ hydraId, at: '2026-10-15T13:00:00Z' }), 1)
    withWriter({ hydraId, fn: ({ writer }) => writer.append({ event: { ...moved, seq: writer.state.seq + 1, id: 'reopened', data: { before: 'done', after: 'parked' } } }) })
    state = loadHydra({ hydraId }).state
    assert.equal(state.cards.t1?.hidden, undefined)
    assert.equal(state.cards.t1?.expired, undefined)
    const events = readFileSync(path, 'utf8').trim()
      .split('\n')
      .map(line => JSON.parse(line) as HydraEvent)
    assert.deepEqual(replay({ state: emptyHydra(), events }), state)

    const snapshot = join(home, 'hydras', hydraId, 'snapshot.json')
    const old = JSON.parse(readFileSync(snapshot, 'utf8')) as { rules: number; state: HydraState }
    old.rules = 8
    old.state.cards.t1!.doneAt = '1900-01-01T00:00:00Z'
    writeFileSync(snapshot, JSON.stringify(old))
    assert.deepEqual(loadHydra({ hydraId }).state, state)
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(home, { recursive: true, force: true })
  }
})

test('non-Done statuses and custom columns never age out', () => {
  const f = fixture()
  const state = f.state()
  state.config = { ...hydraConfig({ state }), columns: [{ id: 'custom:research', title: 'Research' }] }
  state.cards.t1!.column = 'custom:research'
  const event: HydraEvent = { v: 1, seq: state.seq + 1, id: 'status', at: start, actor: 'test', cardId: 't1', type: 'task.declared', data: { state: 'done', note: '' } }
  const next = reduce({ state, event })
  assert.equal(next.cards.t1?.doneAt, undefined)
  assert.equal(doneDeadline({ state: next }), undefined)
})

test('expiry rechecks wall time without another event using a fake clock', t => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-expiry-clock-'))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(start) })

  try {
    const f = fixture()
    withWriter({ hydraId: 'clock', fn: ({ writer }) => writer.append({ event: f.events[0]! }) })
    t.mock.timers.tick(DEFAULT_DONE_HOURS * HOUR_MS - 1)
    assert.equal(hideDone({ hydraId: 'clock' }), 0)
    t.mock.timers.tick(1)
    assert.equal(hideDone({ hydraId: 'clock' }), 1)
    assert.equal(loadHydra({ hydraId: 'clock' }).state.cards.t1?.hidden, true)
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(home, { recursive: true, force: true })
  }
})
