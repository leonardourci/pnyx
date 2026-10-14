import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_KEYBOARD, keyboardError, resolveKey, type KeyContext, type KeyInput, type KeyboardPreferences } from '../src/core/keyboard.ts'
import { emptyBoard, reduce } from '../src/core/reducer.ts'
import { decideUndo, decideView, type Decision } from '../src/core/decide.ts'
import { patchView, viewFor } from '../src/core/view.ts'
import type { BoardEvent } from '../src/core/model.ts'
import { navigate, restoreAnchor } from '../web/src/keyboard/navigation.ts'
import { hintLabels } from '../web/src/keyboard/hints.ts'

const context: KeyContext = { scope: 'board', platform: 'mac', characterShortcuts: true, now: 10 }
const resolve = (
  event: KeyInput,
  change: Partial<KeyContext> = {},
  prefs = DEFAULT_KEYBOARD,
) => resolveKey({ event, context: { ...context, ...change }, prefs })

const event = (d: Decision): BoardEvent => {
  assert.ok('event' in d)

  return d.event
}

test('scopes, exact modifiers and logical punctuation resolve through tinykeys', () => {
  assert.equal(keyboardError({ prefs: DEFAULT_KEYBOARD }), undefined)
  assert.equal(resolve({ key: 'j' }).action, 'board.down')
  assert.equal(resolve({ key: 'j' }, { scope: 'thread' }).action, 'thread.down')
  assert.equal(resolve({ key: 'j' }, { scope: 'navigation' }).consume, false)
  assert.equal(resolve({ key: 'k', metaKey: true }).action, 'palette')
  assert.equal(resolve({ key: 'k', ctrlKey: true }).action, undefined)
  assert.equal(resolve({ key: 'k', ctrlKey: true }, { platform: 'other' }).action, 'palette')
  assert.equal(resolve({ key: 'k', metaKey: true, altKey: true }).consume, false)
  assert.equal(resolve({ key: '?', shiftKey: true, code: 'Slash' }).action, 'help')
  assert.equal(resolve({ key: '/', shiftKey: true, code: 'Digit7' }).action, 'search')
  assert.equal(resolve({ key: ',', metaKey: true }).action, 'settings')

  for (const key of ['p', 'w', 't', 'o', 'T', 'Y']) {
    assert.equal(resolve({ key }).action, undefined)
  }
})
test('typing, IME, dead keys, AltGraph and repeats cannot activate board commands or send', () => {
  for (const scope of ['composer', 'navigation'] as const) {
    for (const key of ['j', 'k', '/', '?', 'm', 'r', 'f', 'Enter']) {
      assert.equal(resolve({ key }, { scope, editing: true }).action, undefined)
    }
  }

  assert.equal(resolve({ key: 'k', metaKey: true }, { scope: 'composer', editing: true }).action, undefined)
  assert.equal(resolve({ key: 'Enter', metaKey: true }, { scope: 'composer', editing: true }).action, 'send')

  for (const scope of ['composer', 'overlay'] as const) {
    assert.equal(resolve({ key: 'Escape' }, { scope, editing: true }).action, 'cancel')
  }

  assert.equal(resolve({ key: 'Escape' }, { scope: 'navigation', editing: true }).consume, false)
  assert.equal(resolve({ key: 'Escape' }, { scope: 'navigation' }).action, 'cancel')

  for (const event of [{ key: 'Enter', isComposing: true, metaKey: true }, { key: 'Process' }, { key: 'Dead' }, { key: 'Enter', metaKey: true, altGraph: true }, { key: 'Enter', metaKey: true, repeat: true }, { key: 'Enter', metaKey: true, defaultPrevented: true }]) {
    assert.equal(resolve(event, { scope: 'composer', editing: true }).action, undefined)
  }

  assert.equal(resolve({ key: 'm', repeat: true }).action, undefined)
  assert.equal(resolve({ key: 'ArrowDown', repeat: true }).action, 'board.down')

  for (const key of ['j', '?', '/', 'f']) {
    assert.equal(resolve({ key }, { characterShortcuts: false }).action, undefined)
  }

  assert.equal(resolve({ key: 'ArrowDown' }, { characterShortcuts: false }).action, 'board.down')
})
test('find uses the platform modifier, works in fields, and remains rebindable', () => {
  for (const platform of ['mac', 'other'] as const) {
    const key = { key: 'f', ...(platform === 'mac' ? { metaKey: true } : { ctrlKey: true }) }

    for (const scope of ['board', 'thread', 'navigation', 'composer'] as const) {
      assert.equal(resolve(key, { platform, scope }).action, 'find')
      assert.equal(resolve(key, { platform, scope, editing: true, characterShortcuts: false }).action, 'find')
    }

    for (const scope of ['overlay', 'hints'] as const) {
      assert.equal(resolve(key, { platform, scope, editing: true }).consume, false)
    }

    const ignored = [
      { shiftKey: true },
      { altKey: true },
      { isComposing: true },
      { altGraph: true },
      { defaultPrevented: true },
      { repeat: true },
    ]

    for (const change of ignored) {
      assert.equal(resolve({ ...key, ...change }, { platform }).consume, false)
    }

    assert.equal(resolve({ key: 'f', ...(platform === 'mac' ? { ctrlKey: true } : { metaKey: true }) }, { platform }).consume, false)
    const prefs = { characterShortcuts: true, bindings: { find: ['Mod+g'] } }
    assert.equal(keyboardError({ prefs }), undefined)
    assert.equal(resolve(key, { platform }, prefs).consume, false)
    assert.equal(resolve({ ...key, key: 'g' }, { platform, editing: true }, prefs).action, 'find')
    assert.equal(resolve(key, { platform }, { ...prefs, bindings: { find: [] } }).consume, false)
  }

  assert.equal(keyboardError({ prefs: { characterShortcuts: true, bindings: { find: ['z'] } } }), undefined)
  assert.equal(resolve({ key: 'z' }, { editing: true }, { characterShortcuts: true, bindings: { find: ['z'] } }).consume, false)
  assert.match(keyboardError({ prefs: { characterShortcuts: true, bindings: { find: [], reply: ['Mod+f'] } } })!, /Reserved/)
  assert.match(keyboardError({ prefs: { characterShortcuts: true, bindings: { find: ['Mod+p'] } } })!, /Reserved/)
})
test('rebinding validates overlapping scopes and sequence prefixes on both platforms', () => {
  const check = (bindings: KeyboardPreferences['bindings']) => keyboardError({ prefs: { characterShortcuts: true, bindings } })
  assert.match(check({ reply: ['j'] })!, /conflicts/)
  assert.match(check({ reply: ['Mod+k'] })!, /conflicts/)
  assert.match(check({ reply: ['Control+k'] })!, /conflicts/)
  assert.match(check({ reply: ['g'], move: ['g m'] })!, /conflicts/)
  assert.match(check({ send: ['Enter'] })!, /Enter always adds a newline/)
  assert.match(check({ cancel: ['q'] })!, /Typing must remain literal/)
  assert.match(check({ cancel: ['Backspace'] })!, /keep editing keys available/)
  assert.match(check({ cancel: ['ArrowDown'] })!, /conflicts|keep editing keys available/)
  assert.equal(check({ cancel: ['Mod+Escape'] }), undefined)
  assert.match(check({ reply: ['Mod+w'] })!, /Reserved/)
  assert.match(check({ reply: ['a b c d'] })!, /three/)
  assert.match(check({ madeup: [] })!, /Unknown/)
  assert.match(check({ move: ['Meta+Mod+m'] })!, /Invalid|modifier|logical/i)
  assert.equal(check({ 'thread.down': ['n'], 'board.down': ['n'] }), undefined)
  assert.equal(check({ reply: ['g r'], move: ['g m'], search: [] }), undefined)
  const prefs = { characterShortcuts: true, bindings: { settings: ['g s'], help: ['g h'] } }
  const first = resolve({ key: 'g' }, {}, prefs); assert.equal(first.consume, true); assert.equal(first.action, undefined)
  assert.equal(resolveKey({ event: { key: 's' }, context: { ...context, now: 500 }, prefs, progress: first.progress }).action, 'settings')
  assert.equal(resolveKey({ event: { key: 's' }, context: { ...context, now: 1600 }, prefs, progress: first.progress }).action, undefined)
  assert.equal(resolveKey({ event: { key: 's' }, context: { ...context, scope: 'composer', editing: true }, prefs, progress: first.progress }).action, undefined)
  assert.equal(resolve({ key: 'g' }, { characterShortcuts: false }, prefs).consume, false)
})
test('keyboard events replay, undo, merge and reset with revision checks and legacy defaults', () => {
  const initial = emptyBoard(), meta = { actor: 'test', at: '2026-10-14T10:00:00Z', id: 'keyboard-edit', ifRevision: 0 }
  const edit = event(decideView({ state: initial, patch: { keyboard: { bindings: { settings: ['g s'] }, characterShortcuts: false } }, meta }))
  const state = reduce({ state: initial, event: edit })
  assert.deepEqual(viewFor({ state }).keyboard, { characterShortcuts: false, bindings: { settings: ['g s'] } })
  assert.deepEqual(reduce({ state: initial, event: edit }), state)
  assert.throws(() => decideView({ state, patch: { keyboard: { bindings: { help: [] } } }, meta: { ...meta, id: 'another' } }), /changed/)
  assert.deepEqual(
    patchView({ state, input: { keyboard: { bindings: { help: [] } } } }).keyboard.bindings,
    { settings: ['g s'], help: [] },
  )
  assert.deepEqual(
    patchView({ state, input: { keyboard: { bindings: { settings: null } } } }).keyboard.bindings,
    {},
  )
  assert.deepEqual(patchView({
    state,
    input: {
      keyboard: {
        bindings: null,
      },
    },
  }).keyboard.bindings, {})
  assert.throws(() => patchView({ state, input: { keyboard: { bindings: { reply: ['m'] } } } }), /conflicts/)
  assert.throws(() => patchView({ state, input: JSON.parse('{"keyboard":{"bindings":{"__proto__":[]}}}') }), /invalid/)
  const undone = reduce({ state, event: event(decideUndo({ state, target: edit, meta: { actor: 'test', at: meta.at, ifRevision: 1 } })) })
  assert.deepEqual(viewFor({ state: undone }).keyboard, DEFAULT_KEYBOARD)
  const old = JSON.parse(JSON.stringify(viewFor({ state }))); delete old.keyboard
  assert.deepEqual(viewFor({ state: { ...initial, view: old } }).keyboard, DEFAULT_KEYBOARD)
  const legacy = JSON.parse(JSON.stringify(event(decideView({ state: initial, patch: { fontSize: 16 }, meta: { ...meta, id: 'legacy-font' } }))))
  delete legacy.data.before.keyboard; delete legacy.data.after.keyboard
  const legacyState = reduce({ state: initial, event: legacy })
  const restored = reduce({ state: legacyState, event: event(decideUndo({ state: legacyState, target: legacy, meta: { actor: 'test', at: meta.at, ifRevision: 1 } })) })
  assert.equal(viewFor({ state: restored }).fontSize, 14)
})
test('ragged columns remember positions, stop at ends, and recover moved or removed focus', () => {
  const columns = [{ id: 'a', cards: ['a1', 'a2', 'a3'] }, { id: 'b', cards: [] }, { id: 'c', cards: ['c1', 'c2'] }]
  assert.deepEqual(navigate({ columns, current: { column: 'a', card: 'a3' }, action: 'board.down', remembered: {} }), { column: 'a', card: 'a3' })
  assert.deepEqual(navigate({ columns, current: { column: 'a', card: 'a2' }, action: 'board.right', remembered: {} }), { column: 'b', card: undefined })
  assert.deepEqual(navigate({ columns, current: { column: 'b' }, action: 'board.right', remembered: { c: 'c2' } }), { column: 'c', card: 'c2' })
  assert.deepEqual(navigate({ columns, current: { column: 'c', card: 'c2' }, action: 'board.first', remembered: {} }), { column: 'c', card: 'c1' })
  const changed = [{ id: 'a', cards: ['a1', 'a3'] }, { id: 'b', cards: ['a2'] }, columns[2]]
  assert.deepEqual(restoreAnchor({ columns: changed, previous: columns, anchor: { column: 'a', card: 'a2' } }), { column: 'b', card: 'a2' })
  assert.deepEqual(restoreAnchor({ columns: [changed[0], columns[1], columns[2]], previous: columns, anchor: { column: 'a', card: 'a2' } }), { column: 'a', card: 'a3' })

  for (const count of [0, 1, 9, 10, 81, 82, 1000]) {
    const labels = hintLabels({ count }); assert.equal(new Set(labels).size, count)

    for (const label of labels) {
      assert.equal(labels.filter(other => other.startsWith(label)).length, 1)
    }
  }
})
