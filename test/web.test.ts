import assert from 'node:assert/strict'
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decideMove, decidePush, decideReply, decideUndo, decideView, type Decision } from '../src/core/decide.ts'
import { emptyBoard, reduce, replay } from '../src/core/reducer.ts'
import { BoardError, COLUMNS, type BoardEvent, type BoardState } from '../src/core/model.ts'
import { clampViewSize, patchView, traces, viewFor, VIEW_SIZE_LIMITS } from '../src/core/view.ts'
import { agentActivity, columnsFor, filterCards, findBoxCards, focusedActivity, pageTitle, safeLink, shouldReload, shownActivity, slashMatches, slashPrefix, visibleParent } from '../web/src/board/view.ts'
import { withWriter } from '../src/store/board-store.ts'
import { latestMessage, readThread, recordEntries } from '../src/thread/read.ts'
import { observe } from '../src/integrations/hooks/observe.ts'
import { briefNotes, relativeTime } from '../web/src/board/brief.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const meta = { at: '2026-10-13T10:00:00Z', actor: 'test' }

const event = ({ d }: { d: Decision }): BoardEvent => {
  assert.ok('event' in d)

  return d.event
}

const push = ({ state, key, fields }: { state: BoardState; key: string; fields: unknown }) =>
  reduce({ state, event: event({ d: decidePush({ state, key, input: fields, meta }) }) })

test('tab titles follow the view, selected card and current needs-you count', () => {
  for (const [page, label] of [['board', 'Board'], ['history', 'History'], ['settings', 'Settings']] as const) {
    assert.equal(pageTitle({ page, cards: {} }), `${label} · Pnyx`)
  }

  let state = push({ state: emptyBoard(), key: 'a', fields: { title: 'Review <literal> changes', attention: [{ kind: 'question', key: 'q', blocking: true }] } })
  state = push({ state, key: 'b', fields: { title: 'Another decision', attention: [{ kind: 'question', key: 'q', blocking: true }] } })
  state = push({ state, key: 'c', fields: { title: 'Still working', activity: 'working' } })
  assert.equal(pageTitle({ page: 'board', cards: state.cards }), '(2) Board · Pnyx')
  assert.equal(pageTitle({ page: 'board', cards: state.cards, selected: 'c1' }), '(2) Review <literal> changes · Pnyx')
  assert.equal(pageTitle({ page: 'board', cards: state.cards, selected: 'missing' }), '(2) Board · Pnyx')
  assert.equal(pageTitle({ page: 'history', cards: state.cards, selected: 'c1' }), '(2) History · Pnyx')
  assert.equal(pageTitle({ page: 'settings', cards: state.cards, selected: 'c1' }), '(2) Settings · Pnyx')
  state = push({ state, key: 'a', fields: { title: 'Updated card title' } })
  state = reduce({ state, event: event({ d: decideMove({ state, ref: 'b', column: 'done', meta }) }) })
  assert.equal(pageTitle({ page: 'board', cards: state.cards, selected: 'c1' }), '(1) Updated card title · Pnyx')
  state = reduce({ state, event: event({ d: decideMove({ state, ref: 'a', column: 'done', meta }) }) })
  assert.equal(pageTitle({ page: 'board', cards: state.cards, selected: 'c1' }), 'Updated card title · Pnyx')
})

test('preferences replay deterministically, guard revisions, and undo removes map overrides', () => {
  const initial = push({ state: emptyBoard(), key: 'a', fields: { title: 'A' } })
  const edit = event({ d: decideView({ state: initial, patch: { columnWidths: { review: 400 }, cardTraceOverrides: { c1: { tools: true } } }, meta: { ...meta, ifRevision: 0, id: 'view-1' } }) })
  const state = reduce({ state: initial, event: edit })
  assert.equal(initial.view, undefined)
  assert.equal(state.viewRevision, 1)
  assert.equal(viewFor({ state }).columnWidths.review, 400)
  assert.deepEqual(reduce({ state: initial, event: edit }), state)
  assert.deepEqual(decideView({ state, patch: {}, meta: { ...meta, id: 'view-1', ifRevision: 0 } }), { skipped: 'duplicate' })
  assert.throws(() => decideView({ state, patch: { fontSize: 18 }, meta: { ...meta, ifRevision: 0 } }), /changed/)
  const undone = reduce({
    state,
    event: event({ d: decideUndo({ state, target: edit, meta: { ...meta, ifRevision: 1 } }) }),
  })
  assert.deepEqual(viewFor({ state: undone }), viewFor({ state: initial }))
  assert.throws(() => patchView({ state, input: { fontSize: 100 } }), BoardError)
  assert.throws(() => patchView({ state, input: { chatFontSize: 100 } }), BoardError)
  assert.throws(() => patchView({ state, input: { codeFontSize: 5 } }), BoardError)
  const sizes = patchView({
    state,
    input: { fontSize: 15, chatFontSize: 18, codeFontSize: 12 },
  })
  assert.deepEqual([sizes.fontSize, sizes.chatFontSize, sizes.codeFontSize], [15, 18, 12])
  assert.throws(() => patchView({ state, input: JSON.parse('{"columnWidths":{"__proto__":300}}') }), BoardError)
})

test('saved resize preferences load within readable size limits', () => {
  const initial = push({ state: emptyBoard(), key: 'a', fields: { title: 'A' } })
  const view = viewFor({ state: initial })
  const loaded = viewFor({
    state: {
      ...initial,
      view: {
        ...view,
        panelWidth: 1,
        composerHeight: 999,
        cardHeight: 1,
        columnWidths: { needs_you: 1, review: 900 },
        cardHeights: { c1: 1 },
      },
    },
  })

  assert.equal(loaded.panelWidth, VIEW_SIZE_LIMITS.panelWidth.min)
  assert.equal(loaded.composerHeight, VIEW_SIZE_LIMITS.composerHeight.max)
  assert.equal(loaded.cardHeight, VIEW_SIZE_LIMITS.cardHeight.min)
  assert.equal(loaded.columnWidths.needs_you, VIEW_SIZE_LIMITS.columnWidth.min)
  assert.equal(loaded.columnWidths.review, VIEW_SIZE_LIMITS.columnWidth.max)
  assert.equal(loaded.cardHeights.c1, VIEW_SIZE_LIMITS.cardHeight.min)
  assert.equal(clampViewSize({ value: 100, min: 320, max: 720 }), 320)
  assert.equal(clampViewSize({ value: 800, min: 320, max: 720 }), 720)
  assert.equal(clampViewSize({ value: 320.5, min: 320, max: 720 }), 321)
})

test('custom columns accept manual placement and return their cards to auto when deleted', () => {
  let state = push({ state: emptyBoard(), key: 'a', fields: { attention: [{ kind: 'question', key: 'q', blocking: true }] } })
  state = reduce({ state, event: event({ d: decideView({ state, patch: { customColumns: [{ id: 'custom:later', title: 'Later' }] }, meta }) }) })
  assert.equal(columnsFor({ state }).at(-1)?.title, 'Later')
  assert.equal(patchView({ state: emptyBoard(), input: { columnWidths: { 'custom:one': 400 }, customColumns: [{ id: 'custom:one', title: 'One' }] } }).columnWidths['custom:one'], 400)
  state = reduce({ state, event: event({ d: decideMove({ state, ref: 'a', column: 'custom:later', meta }) }) })
  assert.equal(state.cards.c1!.column, 'custom:later')
  assert.deepEqual(patchView({ state, input: { customColumns: [] } }).customColumns, [])
  assert.throws(() => decideMove({ state, ref: 'a', column: 'custom:missing', meta }), /unknown/)
  const toAuto = event({ d: decideMove({ state, ref: 'a', column: null, meta }) })
  state = reduce({ state, event: toAuto })
  assert.equal(state.cards.c1!.column, 'needs_you')
  assert.equal(state.cards.c1!.attention.length, 1)
  state = reduce({
    state,
    event: event({
      d: decideView({
        state,
        patch: {
          customColumns: [],
        },
        meta,
      }),
    }),
  })
  assert.throws(() => decideUndo({ state, target: toAuto, meta }), /unknown custom column/)
})

test('filters do not expose excluded parent details, and links/slashes stay literal', () => {
  let state = push({ state: emptyBoard(), key: 'parent', fields: { title: 'Private parent', workspace: 'A' } })
  state = push({ state, key: 'child', fields: { title: 'Searchable child', workspace: 'B', parent: 'parent', tags: ['ui'] } })
  const visible = filterCards({ state, workspace: 'B', tag: 'ui', query: 'searchable' })
  assert.equal(visible.length, 1)
  assert.equal(visibleParent({ card: visible[0]!, visible }), undefined)
  assert.equal(safeLink({ link: { kind: 'url', url: 'javascript:alert(1)' } }), undefined)
  assert.equal(slashPrefix({ text: '/plan', cursor: 5 }), '/plan')
  assert.equal(slashPrefix({ text: 'open /path', cursor: 10 }), null)
  assert.equal(slashPrefix({ text: '/tmp/file', cursor: 9 }), null)

  for (const typed of ['/d', '/D', '/dep']) {
    assert.equal(slashMatches({ command: '/Deploy', prefix: slashPrefix({ text: typed, cursor: typed.length })! }), true)
  }

  assert.equal(slashMatches({ command: '$Review', prefix: '/rev' }), true)
  assert.equal(slashMatches({ command: '/Deploy', prefix: '/r' }), false)
})

test('the Find box shows every card its filter matches, then the strong meaning-only cards', () => {
  let state = emptyBoard()

  for (let i = 0; i < 35; i += 1) {
    state = push({ state, key: `deploy-${i}`, fields: { title: `Deploy step ${i}`, workspace: 'A' } })
  }

  state = push({ state, key: 'ops-rotation', fields: { title: 'Rotate keys', workspace: 'A', tags: ['infra'] } })
  state = push({ state, key: 'cookie', fields: { title: 'Session cookie', workspace: 'B' } })
  const id = ({ key }: { key: string }) => Object.values(state.cards).find(c => c.key === key)!.id
  const ids = ({ cards }: { cards: { id: string }[] }) => cards.map(c => c.id)

  // Semantic search off (no meaning-only cards): exactly the filter, every match, partial words, tags and keys.
  for (const query of ['deploy', 'dep', 'infra', 'ops-rot', 'step 3', 'nothing like it', '']) {
    assert.deepEqual(findBoxCards({ state, workspace: '', tag: '', query, meaning: [] }), filterCards({ state, workspace: '', tag: '', query }))
  }

  assert.equal(findBoxCards({ state, workspace: '', tag: '', query: 'dep', meaning: [] }).length, 35)
  assert.deepEqual(ids({ cards: findBoxCards({ state, workspace: '', tag: '', query: 'infra', meaning: [] }) }), [id({ key: 'ops-rotation' })])
  assert.deepEqual(ids({ cards: findBoxCards({ state, workspace: '', tag: '', query: 'ops-rot', meaning: [] }) }), [id({ key: 'ops-rotation' })])

  // Meaning-only cards come after, once each, within the workspace and tag filters.
  const found = findBoxCards({ state, workspace: '', tag: '', query: 'deploy', meaning: [id({ key: 'cookie' }), id({ key: 'deploy-0' }), 'gone'] })
  assert.deepEqual(ids({ cards: found }), [...ids({ cards: filterCards({ state, workspace: '', tag: '', query: 'deploy' }) }), id({ key: 'cookie' })])
  assert.equal(findBoxCards({ state, workspace: 'A', tag: '', query: 'deploy', meaning: [id({ key: 'cookie' })] }).length, 35)
  assert.deepEqual(ids({ cards: findBoxCards({ state, workspace: '', tag: 'infra', query: 'deploy', meaning: [id({ key: 'cookie' }), id({ key: 'ops-rotation' })] }) }), [id({ key: 'ops-rotation' })])
})

test('thread reader ignores partial records, pages old messages, separates traces and reports unavailable capabilities', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-thread-')); process.env.PNYX_HOME = home
  const path = join(home, 'session.jsonl')
  const records = Array.from({ length: 90 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: `message ${i}` } }))
  writeFileSync(path, records.join('\n') + '\n{"partial":')
  const state = push({ state: emptyBoard(), key: 'a', fields: { agent: { provider: 'claude', sessionId: 'fixture', transcriptPath: path } } })
  const page = readThread({ board: 'default', state, card: state.cards.c1!, homes: [] })
  assert.equal(page.entries.length, 60); assert.equal(page.entries.at(-1)?.text, 'message 89'); assert.ok(page.older)
  const older = readThread({ board: 'default', state, card: state.cards.c1!, homes: [], before: page.older })
  assert.equal(older.entries.length, 30); assert.equal(older.entries[0]?.text, 'message 0'); assert.equal(older.older, undefined)
  assert.equal(page.route, false); assert.equal(page.watching, 'unknown')
  const entries = recordEntries({ record: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'thinking' }, { type: 'tool_use', input: 'sk-abcdefghijklmnop123456789' }] } }, offset: 0 })
  assert.deepEqual(entries.map(e => e.kind), ['message', 'thinking', 'tool']); assert.equal(entries[2]?.text, '[redacted]')
  assert.deepEqual(recordEntries({ record: { type: 'user', isMeta: true, message: { content: 'injected' } }, offset: 0 }), [])
})

test('Focus hides traces before paging so tool-heavy output cannot push replies off the page', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-focus-')); process.env.PNYX_HOME = home
  const path = join(home, 'session.jsonl')
  const replies = Array.from({ length: 3 }, (_, i) => ({ type: 'assistant', message: { content: `reply ${i}` } }))
  const tools = Array.from({ length: 120 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', input: `tool ${i}` }] } }))
  writeFileSync(path, [...replies, ...tools].map(r => JSON.stringify(r)).join('\n') + '\n')
  let state = push({ state: emptyBoard(), key: 'a', fields: { activity: 'running git status', agent: { provider: 'claude', sessionId: 'fixture', transcriptPath: path } } })
  const focused = readThread({ board: 'default', state, card: state.cards.c1!, homes: [] })
  assert.deepEqual(focused.entries.map(e => e.text), ['reply 0', 'reply 1', 'reply 2'])
  assert.ok(traces({ view: viewFor({ state }), card: 'c1' }).focus)
  assert.equal(focusedActivity({ activity: state.cards.c1!.activity, focus: true }), 'working')
  const showTools = { cardTraceOverrides: { c1: { tools: true } } }
  state = reduce({ state, event: event({ d: decideView({ state, patch: showTools, meta }) }) })
  const full = readThread({ board: 'default', state, card: state.cards.c1!, homes: [] })
  assert.equal(full.entries.length, 60); assert.ok(full.entries.every(e => e.kind === 'tool'))
  const { focus } = traces({ view: viewFor({ state }), card: 'c1' })
  assert.equal(focusedActivity({ activity: 'running git status', focus }), 'running git status')
  assert.equal(focusedActivity({ activity: 'idle', focus: true }), 'idle')

  for (const activity of ['ran git status', 'task: review the diff', 'task done: review the diff', 'Bash failed', 'Edit denied']) {
    assert.equal(focusedActivity({ activity, focus: true }), 'working')
  }
})

test('Focus pages messages from a tool-heavy tail larger than the first read window', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-focus-window-')); process.env.PNYX_HOME = home
  const path = join(home, 'session.jsonl'), padding = 'x'.repeat(4000)
  const records = Array.from({ length: 90 }, (_, i) => [
    { type: 'assistant', message: { content: `message ${i}` } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: `${padding} ${i}` }] } },
  ]).flat()
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  const state = push(emptyBoard(), 'a', { agent: { provider: 'claude', sessionId: 'fixture', transcriptPath: path } })
  const page = readThread('default', state, state.cards.c1!, [])
  assert.deepEqual(page.entries.map(e => e.text), Array.from({ length: 60 }, (_, i) => `message ${i + 30}`))
  const older = readThread('default', state, state.cards.c1!, [], page.older)
  assert.deepEqual(older.entries.map(e => e.text), Array.from({ length: 30 }, (_, i) => `message ${i}`))
  assert.equal(older.older, undefined)
})

test('long transcript messages and reply history page without losing text or duplicating entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-thread-pages-')); process.env.PNYX_HOME = home
  const path = join(home, 'session.jsonl'), longText = 'abcdefghij'.repeat(7000)
  writeFileSync(path, JSON.stringify({ type: 'assistant', timestamp: '2026-10-12T10:00:00Z', message: { content: longText } }) + '\n')
  const state = withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      w.append({ event: event({ d: decidePush({ state: w.state, key: 'a', input: { agent: { provider: 'claude', sessionId: 'fixture', transcriptPath: path } }, meta }) }) })

      for (let i = 0; i < 90; i++) {
        w.append({ event: event({ d: decideReply({ state: w.state, ref: 'a', data: { reply: `r${i}`, state: 'queued', route: 'fixture', text: `reply ${i}` }, meta }) }) })
      }

      return w.state
    },
  })
  let cursor: string | undefined
  const pages: ReturnType<typeof readThread>['entries'][] = []

  do {
    const page = readThread({ board: 'default', state, card: state.cards.c1!, homes: [], before: cursor })
    assert.ok(page.entries.length <= 60)
    pages.unshift(page.entries); cursor = page.older
    assert.ok(pages.length < 10, 'pagination terminates')
  } while (cursor)

  const entries = pages.flat()
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length)
  assert.equal(entries.filter(e => e.role.startsWith('assistant')).map(e => e.text)
    .join(''), longText)
  assert.equal(entries.filter(e => e.role === 'You').length, 90)
  const later = withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      w.append({ event: event({ d: decideReply({ state: w.state, ref: 'a', data: { reply: 'r90', state: 'queued', route: 'fixture', text: 'reply 90' }, meta }) }) })

      return w.state
    },
  })
  assert.equal(readThread({ board: 'default', state: later, card: later.cards.c1!, homes: [] }).entries.at(-1)?.text, 'reply 90')
})

test('a tab reloads only when it reconnects to a server serving another build', () => {
  assert.equal(shouldReload({ loaded: 'aaa111', server: 'bbb222' }), true)
  assert.equal(shouldReload({ loaded: 'aaa111', server: 'aaa111' }), false)
  // The Vite dev page has no build; hot module replacement updates it instead.
  assert.equal(shouldReload({ loaded: undefined, server: 'bbb222' }), false)
  assert.equal(shouldReload({ loaded: '', server: 'bbb222' }), false)
  // A server with nothing built cannot name a newer page.
  assert.equal(shouldReload({ loaded: 'aaa111', server: '' }), false)
})

test("a card's last message comes from the transcript tail, without tool calls, thinking, injected or torn text", () => {
  const fixture = ({ name }: { name: string }) => join(import.meta.dirname, 'fixtures/transcripts', name)
  const claude = latestMessage({ path: fixture({ name: 'claude-session.jsonl' }) }).message!
  // The summary record and the torn last line are skipped; long text is cut to two card lines.
  assert.equal(claude.role, 'assistant')
  assert.equal(claude.at, '2026-10-11T09:02:00.000Z')
  assert.match(claude.text, /^Paragraph 0 about the orders table backfill\. Rows are copied/)
  assert.ok(claude.text.length <= 280 && claude.text.endsWith('…'))
  assert.deepEqual(latestMessage({ path: fixture({ name: 'codex-session.jsonl' }) }).message, { role: 'assistant', text: 'The export query scans every invoice without an index.', at: '2026-10-12T10:00:07.000Z' })
  // A newer Codex user message wins over the reply, its injected context stripped, even
  // when tool output after it overflows the first read window.
  const dir = mkdtempSync(join(tmpdir(), 'pnyx-latest-')), path = join(dir, 'codex.jsonl')
  const line = ({ payload }: { payload: unknown }) => JSON.stringify({ timestamp: '2026-10-12T10:01:00.000Z', type: 'response_item', payload }) + '\n'
  writeFileSync(path, readFileSync(fixture({ name: 'codex-session.jsonl' }), 'utf8') + line({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/work</cwd>\n</environment_context>Now add the index.' }] } }) + line({ payload: { type: 'function_call_output', call_id: 'c2', output: 'x'.repeat(200_000) } }))
  assert.deepEqual(latestMessage({ path }).message, { role: 'user', text: 'Now add the index.', at: '2026-10-12T10:01:00.000Z' })
  assert.equal(latestMessage({ path: join(dir, 'missing.jsonl') }).message, null)
  writeFileSync(path, line({ payload: { type: 'reasoning', summary: [] } }))
  assert.equal(latestMessage({ path }).message, null)
})

test("a card's last message is read again from only what its transcript gained", () => {
  const dir = mkdtempSync(join(tmpdir(), 'pnyx-latest-')), path = join(dir, 'claude.jsonl')
  const line = ({ type, text, at }: { type: string; text: string; at: string }) => JSON.stringify({ type, timestamp: at, message: { content: [{ type: 'text', text }] } }) + '\n'
  const tool = JSON.stringify({ type: 'assistant', timestamp: '2026-10-12T10:02:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }) + '\n'
  writeFileSync(path, line({ type: 'assistant', text: 'First reply.', at: '2026-10-12T10:00:00.000Z' }))
  const first = latestMessage({ path })
  assert.equal(first.message?.text, 'First reply.')
  // Appended tool calls and a torn line hold no message: the previous one stays, and the torn line is read once complete.
  const torn = line({ type: 'user', text: 'Ship it.', at: '2026-10-12T10:03:00.000Z' })
  appendFileSync(path, tool + torn.slice(0, 20))
  const second = latestMessage({ path, prev: first })
  assert.equal(second.message?.text, 'First reply.')
  assert.equal(second.size, first.size + tool.length)
  appendFileSync(path, torn.slice(20))
  // The earlier bytes are never read again: overwriting them in place changes nothing.
  const fd = openSync(path, 'r+'); writeSync(fd, 'x', 0); closeSync(fd)
  const third = latestMessage({ path, prev: second })
  assert.equal(third.message?.text, 'Ship it.')
  // A file replaced or cut short is read back from its end.
  writeFileSync(path, line({ type: 'assistant', text: 'Fresh.', at: '2026-10-12T11:00:00.000Z' }))
  assert.equal(latestMessage({ path, prev: third }).message?.text, 'Fresh.')
})

test('deleting a populated column is atomic, replayable, undoable and guarded', () => {
  const events: BoardEvent[] = []
  let state = emptyBoard()

  const apply = ({ d }: { d: Decision }) => {
    const e = event({ d }); events.push(e); state = reduce({ state, event: e })

    return e
  }

  apply({ d: decidePush({ state, key: 'question', input: { attention: [{ kind: 'question', key: 'q', blocking: true }] }, meta }) })
  apply({ d: decidePush({ state, key: 'worker', input: {}, meta }) })
  apply({ d: decideView({ state, patch: { customColumns: [{ id: 'custom:later', title: 'Later' }], columnWidths: { 'custom:later': 400 } }, meta }) })
  apply({ d: decideMove({ state, ref: 'question', column: 'custom:later', meta }) })
  apply({ d: decideMove({ state, ref: 'worker', column: 'custom:later', meta }) })
  const before = structuredClone(state)
  const deletion = apply({ d: decideView({ state, patch: { customColumns: [] }, meta: { ...meta, id: 'delete', ifRevision: 1 } }) })
  assert.equal(state.cards.c1!.column, 'needs_you')
  assert.equal(state.cards.c2!.column, 'workers_on_it')
  assert.equal(state.cards.c1!.manualColumn, undefined)
  assert.equal(viewFor({ state }).columnWidths['custom:later'], undefined)
  assert.deepEqual(replay({ state: emptyBoard(), events }), state)
  assert.deepEqual(decideView({ state, patch: { customColumns: [] }, meta: { ...meta, id: 'delete', ifRevision: 1 } }), { skipped: 'duplicate' })
  const later = reduce({ state, event: event({ d: decideMove({ state, ref: 'worker', column: 'done', meta }) }) })
  assert.throws(() => decideUndo({ state: later, target: deletion, meta }), /moved since/)
  const undo = apply({
    d: decideUndo({
      state,
      target: deletion,
      meta: {
        ...meta,
        ifRevision: 2,
      },
    }),
  })
  assert.deepEqual(viewFor({ state }), viewFor({ state: before }))
  assert.equal(state.cards.c1!.manualColumn, 'custom:later')
  assert.equal(state.cards.c2!.column, 'custom:later')
  assert.deepEqual(state.cards.c1!.attention, before.cards.c1!.attention)
  const redo = apply({ d: decideUndo({ state, target: undo, meta }) })
  assert.deepEqual(redo.type === 'board.view' && redo.data.placements?.map(p => p.cardId), ['c1', 'c2'])
  assert.equal(state.cards.c1!.column, 'needs_you')
  assert.deepEqual(replay({ state: emptyBoard(), events }), state)

  for (const id of COLUMNS) {
    assert.throws(() => patchView({ state, input: { customColumns: [{ id, title: 'Replacement' }] } }), /invalid/)
  }
})

test('themes validate, default to System on older boards, and undo', () => {
  assert.equal(viewFor({ state: emptyBoard() }).theme, 'system')

  for (const theme of ['light', 'dark', 'system']) {
    assert.equal(patchView({ state: emptyBoard(), input: { theme } }).theme, theme)
  }

  assert.throws(() => patchView({ state: emptyBoard(), input: { theme: 'sepia' } }), /invalid/)
  const change = event({ d: decideView({ state: emptyBoard(), patch: { theme: 'light' }, meta }) })
  const state = reduce({ state: emptyBoard(), event: change })
  assert.equal(viewFor({ state }).theme, 'light')
  assert.equal(viewFor({ state: reduce({ state, event: event({ d: decideUndo({ state, target: change, meta }) }) }) }).theme, 'system')
})

test('the notes header keeps the newest distinct notes and skips text already in the chat', () => {
  const note = { at: '2026-10-13T10:00:00Z', source: 'firstmate', text: 'resolved: Keep the composer visible.' }
  const newer = { ...note, at: '2026-10-13T11:00:00Z' }
  assert.deepEqual(briefNotes({ notes: [note, newer, { ...note, text: 'Already in the chat.' }], conversation: ['Already in the chat.'] }), [newer])
  assert.deepEqual(briefNotes({ notes: [note], conversation: ['Keep the composer visible.'] }), [])
  assert.equal(relativeTime({ at: note.at, now: Date.parse('2026-10-13T10:02:00Z') }), '2m ago')
  assert.equal(relativeTime({ at: undefined, now: 0 }), 'Time not recorded')
})

test('a live joined session drives the running indicator; Firstmate status shows once it ends', () => {
  const firstmate = { activity: 'working: task status', source: { adapter: 'firstmate', objectId: 'task' } }
  let state = push({ state: emptyBoard(), key: 'task', fields: { title: 'Joined task', ...firstmate } })
  assert.equal(agentActivity({ card: state.cards.c1! }), undefined)

  for (const [hook, expected] of [['UserPromptSubmit', 'working'], ['PreToolUse', 'working'], ['PostToolUseFailure', 'working'], ['Stop', 'idle']] as const) {
    const [observed] = observe({ envelope: { v: 1, id: hook, at: meta.at, harness: 'claude', event: hook, payload: { session_id: 'fixture', tool_name: 'Read' } } })
    assert.ok(observed)
    state = push({ state, key: 'task', fields: observed.card })
    assert.equal(agentActivity({ card: state.cards.c1! }), expected)
    state = push({ state, key: 'task', fields: firstmate })
    assert.equal(state.cards.c1!.activity, 'working: task status')
    assert.equal(agentActivity({ card: state.cards.c1! }), expected)
  }

  const [ended] = observe({ envelope: { v: 1, id: 'end', at: meta.at, harness: 'claude', event: 'SessionEnd', payload: { session_id: 'fixture' } } })
  assert.ok(ended)
  state = push({ state, key: 'task', fields: ended.card })
  assert.equal(shownActivity({ card: state.cards.c1! }), 'ended')
  state = push({ state, key: 'task', fields: { ...firstmate, activity: 'working: new step' } })
  assert.equal(shownActivity({ card: state.cards.c1! }), 'working: new step')
  assert.equal(agentActivity({ card: state.cards.c1! }), 'ended')
})

test('in-turn tool failures, denials and task updates count as working', () => {
  for (const activity of ['Bash failed', 'Edit denied', 'task: write tests', 'task done: write tests']) {
    assert.equal(agentActivity({ card: { ...push({ state: emptyBoard(), key: 'k', fields: { agent: { provider: 'claude', sessionId: 's' } } }).cards.c1!, activity } }), 'working')
  }
})
