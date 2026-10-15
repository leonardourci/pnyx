import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '../src/server/server.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'
import { decideMove, decidePush } from '../src/core/decide.ts'
import { seedWebFixture } from './web-fixture.ts'
import { boardConfig, hydraEvent } from '../src/core/hydra.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const exec = promisify(execFile), home = mkdtempSync(join(tmpdir(), 'pnyx-keyboard-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home }), cwd = join(home, 'project'), skill = join(cwd, '.claude/skills/review-local')
mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\nname: review-local\ndescription: Review the local fixture\n---\nLiteral fixture only\n')
const meta = { actor: 'fixture', at: '2026-10-14T10:00:00Z' }
withWriter({
  board: 'default',
  fn: ({ writer: w }) => {
    const d = decidePush({ state: w.state, key: 'layout', input: { agent: { ...w.state.cards[fixture.state.keys.layout!]!.agent, cwd } }, meta }); assert.ok('event' in d); w.append({ event: d.event })
  },
})
const server = await startServer({ board: 'default', homes: [fixture.nativeHome], catalogLocations: { home, claude: join(home, '.claude'), codex: join(home, '.codex') } })
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-keyboard-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence'); mkdirSync(evidence, { recursive: true })

const browser = async ({ args = [] }: { args?: string[] } = {}) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })

  if (/^error:/m.test(stdout)) {
    throw new Error(stdout)
  }

  return stdout
}

const check = async ({ condition, label }: { condition: string; label: string }) => {
  const out = await browser({ args: ['eval', `() => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return "passed"; }`] }); assert.match(out, /passed/, label)
}

const ref = async ({ role, name }: { role: string; name: string }) => {
  const snapshot = await browser({ args: ['snapshot'] }), line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`)); assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async ({ role, name }: { role: string; name: string }) => browser({ args: ['click', await ref({ role, name })] })
const fill = async ({ role, name, text }: { role: string; name: string; text: string }) => browser({ args: ['fill', await ref({ role, name }), text] })
const press = ({ key }: { key: string }) => browser({ args: ['press', key] })
const focus = ({ selector }: { selector: string }) => browser({ args: ['eval', `() => { document.querySelector(${JSON.stringify(selector)}).focus(); return true; }`] })
const active = ({ selector }: { selector: string }) => `document.activeElement.matches(${JSON.stringify(selector)})`
const caretAt = ({ offset }: { offset: string }) => `document.activeElement.matches("[data-caret-host]") && getSelection().isCollapsed && getSelection().focusNode.data?.startsWith("The first pass") && getSelection().focusOffset === ${offset}`
const cardSelector = `[data-card="${fixture.state.keys.layout}"]`
const board = () => loadBoard({ board: 'default' }).state

const screenshot = async ({ name }: { name: string }) => {
  const path = join(evidence, name); rmSync(path, { force: true })

  try {
    await browser({ args: ['screenshot', path] })
  } catch (error) {
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'Needs you'] })
  const platform = await browser({ args: ['eval', "() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'"] }); const mod = platform.includes('mac') ? 'Meta' : 'Control'
  const findPrevented = ({ expected }: { expected: boolean }) => check({ condition: `(() => { const event = new KeyboardEvent('keydown', { key: 'f', ${mod === 'Meta' ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(event); return event.defaultPrevented === ${expected}; })()`, label: `browser find prevented: ${expected}` })
  await focus({ selector: cardSelector }); await press({ key: `${mod}+b` }); await check({ condition: "document.querySelector('.topbar').hidden", label: 'Mod+B hides the top bar' })
  await press({ key: `${mod}+b` }); await check({ condition: "!document.querySelector('.topbar').hidden", label: 'Mod+B shows the top bar again' })
  await focus({ selector: cardSelector }); await press({ key: `${mod}+f` }); await check({ condition: active({ selector: "[aria-label='Search board']" }), label: 'Mod+F focuses board search' })
  await fill({ role: 'searchbox', name: 'Search board', text: 'Shape' }); await findPrevented({ expected: true }); await check({ condition: active({ selector: "[aria-label='Search board']" }) + " && document.activeElement.value === 'Shape'", label: 'find in search preserves the query' })
  await press({ key: 'Escape' })
  await focus({ selector: cardSelector })
  await browser({ args: ['eval', "() => { document.querySelector(\"[aria-label='Search board']\").disabled = true; return true; }"] })
  await findPrevented({ expected: false })
  await browser({ args: ['eval', "() => { document.querySelector(\"[aria-label='Search board']\").disabled = false; return true; }"] })
  await focus({ selector: cardSelector }); await press({ key: 'ArrowDown' }); await check({ condition: active({ selector: `[data-card="${fixture.state.keys.coverage}"]` }), label: 'down moves to next card' })
  await press({ key: 'k' }); await check({ condition: active({ selector: cardSelector }), label: 'k moves back' }); await press({ key: 'ArrowRight' }); await check({ condition: "document.activeElement.closest('[data-column]').dataset.column === 'workers_on_it'", label: 'right crosses columns' })
  await press({ key: 'h' }); await check({ condition: active({ selector: cardSelector }), label: 'left remembers column focus' })
  await press({ key: 'Enter' }); await browser({ args: ['wait', 'The first pass is ready to review.'] }); await check({ condition: active({ selector: '.composer textarea' }), label: 'Enter opens the conversation at its reply input' })
  await press({ key: `${mod}+k` }); await fill({ role: 'searchbox', name: 'Search board', text: '> theme' }); await press({ key: 'ArrowDown' }); await press({ key: 'Escape' })
  await check({ condition: '!document.querySelector(".search-results") && !!document.querySelector(".detail") && document.activeElement.matches(".composer textarea")', label: 'Escape in a result button closes only search and restores its composer' })
  await press({ key: `${mod}+k` }); await fill({ role: 'searchbox', name: 'Search board', text: '> Hydra default model' }); await focus({ selector: '[aria-label="Hydra default model"]' }); await press({ key: 'Escape' })
  await check({ condition: '!document.querySelector(".search-results") && !!document.querySelector(".detail") && document.activeElement.matches(".composer textarea")', label: 'Escape in a setting field closes only search and restores its composer' })
  await press({ key: `${mod}+k` }); await press({ key: `${mod}+a` }); await press({ key: 'Backspace' }); await press({ key: 'Escape' })
  await press({ key: 'Escape' }); await check({ condition: caretAt({ offset: '0' }), label: 'Escape puts the caret at the start of the latest reply' })
  await browser({ args: ['eval', '() => { window.messagesText = document.querySelector("[data-caret-host]").textContent; return true; }'] })
  await press({ key: 'ArrowRight' }); await press({ key: 'ArrowRight' }); await check({ condition: caretAt({ offset: '2' }), label: 'arrows move the caret' })
  await press({ key: 'x' }); await press({ key: 'Backspace' }); await press({ key: 'Enter' }); await check({ condition: active({ selector: '.composer textarea' }) + ' && document.querySelector("[data-caret-host]").textContent === window.messagesText', label: 'typing never edits the output and Enter without a selection returns to the reply input' })
  await press({ key: `${mod}+l` }); await check({ condition: caretAt({ offset: '0' }), label: 'Mod+L jumps from the reply input to the latest reply' })
  await press({ key: `${mod}+l` }); await check({ condition: active({ selector: '.composer textarea' }), label: 'Mod+L jumps back to the reply input' })
  await press({ key: 'ArrowUp' }); await check({ condition: caretAt({ offset: 'getSelection().focusNode.length' }), label: 'Up from the top of the reply input enters the end of the latest reply' })
  await press({ key: 'ArrowDown' }); await check({ condition: active({ selector: '.composer textarea' }), label: 'Down past the end of the output returns to the reply input' })
  await press({ key: 'Escape' }); await press({ key: 'Shift+End' }); await check({ condition: 'getSelection().toString().startsWith("The first pass") && !!document.querySelector(".block-comment-action.has-selection")', label: 'Shift extends a selection that offers a comment' })
  await press({ key: 'Shift+Enter' }); await check({ condition: active({ selector: '.composer textarea' }) + ' && document.activeElement.value.startsWith("> The first pass")', label: 'Shift+Enter quotes the selection into the reply input' })
  await browser({ args: ['eval', '() => { const input = document.querySelector(".composer textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); return true; }'] })
  await press({ key: 'Escape' }); await press({ key: 'Shift+End' }); await press({ key: 'Enter' }); await check({ condition: active({ selector: '.inline-comment textarea' }), label: 'Enter comments on the selection' })
  await press({ key: 'Escape' }); await check({ condition: caretAt({ offset: '0' }) + " && !document.querySelector('.inline-comment')", label: 'Escape leaves an empty comment for the caret' })
  await press({ key: 'Escape' }); await check({ condition: active({ selector: '.thread' }) + ' && getSelection().rangeCount === 0', label: 'Escape hides the caret' }); await press({ key: 'Enter' }); await check({ condition: active({ selector: '.composer textarea' }), label: 'Enter returns to the reply input' })
  await press({ key: 'Escape' }); await press({ key: 'r' }); await check({ condition: active({ selector: '.composer textarea' }), label: 'r focuses composer' })
  await press({ key: `${mod}+f` }); await check({ condition: active({ selector: "[aria-label='Search board']" }), label: 'Mod+F leaves a text field for board search' }); await focus({ selector: '.composer textarea' })
  await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: 'hjkl / ? m' }); await press({ key: 'Enter' }); await press({ key: 'j' })
  await check({ condition: "document.querySelector('.composer textarea').value === 'hjkl / ? m\\nj' && !document.querySelector('[role=dialog]')", label: 'typing stays literal' })
  await press({ key: 'Escape' }); await check({ condition: caretAt({ offset: '0' }), label: 'Escape leaves composer' }); await press({ key: 'Escape' }); await check({ condition: active({ selector: '.thread' }), label: 'Escape hides the caret' }); await press({ key: 'Escape' }); await check({ condition: active({ selector: cardSelector }) + " && !document.querySelector('.detail')", label: 'Escape restores board focus' })
  await press({ key: 'r' }); await browser({ args: ['wait', 'Reply to Shape the first working board'] }); await check({ condition: "document.querySelector('.composer textarea').value === 'hjkl / ? m\\nj'", label: 'draft survives keyboard navigation' })
  const beforeSlash = board().seq
  await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: '/' }); await browser({ args: ['wait', '/review-local'] }); await screenshot({ name: 'keyboard-slash.png' })
  await press({ key: 'ArrowDown' }); await press({ key: 'Enter' }); await check({ condition: "document.querySelector('.composer textarea').value === '/review-local ' && !document.querySelector('.slash-menu')", label: 'completion inserts literal command' }); assert.equal(board().seq, beforeSlash)
  await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: '/rev' }); await browser({ args: ['wait', '/review-local'] }); await press({ key: 'Escape' }); await check({ condition: active({ selector: 'textarea' }) + " && !document.querySelector('.slash-menu')", label: 'Escape only closes suggestions' })
  await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: 'Keyboard fixture reply' })
  await press({ key: `${mod}+Enter` }); await browser({ args: ['wait', 'Delivered'] }); assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /Keyboard fixture reply/)
  const replyCount = board().cards[fixture.state.keys.layout!]!.replies!.length
  await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: 'Keep this draft' })
  await browser({ args: ['eval', `() => { document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ${mod === 'Meta' ? 'metaKey' : 'ctrlKey'}: true, repeat: true, bubbles: true })); return true; }`] })
  assert.equal(board().cards[fixture.state.keys.layout!]!.replies!.length, replyCount)
  await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Escape' })
  await press({ key: 'm' }); await browser({ args: ['wait', 'Placement does not complete work'] }); await fill({ role: 'combobox', name: 'Search Move card', text: 'Done' }); await press({ key: 'Enter' }); await browser({ args: ['wait', 'Placement updated'] })
  assert.equal(board().cards[fixture.state.keys.layout!]!.column, 'done'); assert.equal(board().cards[fixture.state.keys.layout!]!.attention.length, 1)
  await check({ condition: active({ selector: cardSelector }), label: 'moving a focused card follows its identity' })
  const frames = () => browser({ args: ['eval', '() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 50))))'] })

  for (const [query, title] of [['Keyboard help', 'Keyboard help']]) {
    await press({ key: `${mod}+k` }); await browser({ args: ['wait', 'Search board'] }); await fill({ role: 'searchbox', name: 'Search board', text: `> ${query}` }); await click({ role: 'button', name: query }); await browser({ args: ['wait', `Search ${title}`] }); await frames()
    await check({ condition: `document.activeElement.matches("[aria-label='Search ${title}']")`, label: `palette hands focus to ${title}` })
    await press({ key: 'Escape' }); await frames(); await check({ condition: active({ selector: cardSelector }), label: `${title} restores the card after the palette` })
  }

  await press({ key: `${mod}+k` }); await browser({ args: ['wait', 'Search board'] }); await fill({ role: 'searchbox', name: 'Search board', text: '> top bar' }); await click({ role: 'button', name: 'Show or hide the top bar' }); await frames()
  await check({ condition: "document.querySelector('.topbar').hidden", label: 'the palette hides the top bar' })
  await focus({ selector: cardSelector }); await press({ key: `${mod}+b` }); await check({ condition: "!document.querySelector('.topbar').hidden", label: 'Mod+B brings the top bar back' })
  await press({ key: `${mod}+k` }); await browser({ args: ['wait', 'Search board'] }); await screenshot({ name: 'keyboard-palette.png' })
  await findPrevented({ expected: true })
  await fill({ role: 'searchbox', name: 'Search board', text: '> settings' }); await click({ role: 'button', name: 'Open settings' }); await browser({ args: ['wait', 'Keyboard shortcuts'] })
  await findPrevented({ expected: false })
  await click({ role: 'button', name: 'Rebind Find in current view' }); await fill({ role: 'textbox', name: 'One binding per line', text: 'Mod+g' }); await click({ role: 'button', name: 'Save binding' }); await browser({ args: ['wait', 'Preferences saved'] })
  assert.deepEqual(board().view!.keyboard.bindings.find, ['Mod+g'])
  await click({ role: 'button', name: 'Back to board' }); await focus({ selector: cardSelector }); await findPrevented({ expected: false }); await press({ key: `${mod}+g` }); await check({ condition: active({ selector: "[aria-label='Search board']" }), label: 'find honors the custom binding' })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'button', name: 'Rebind Find in current view' }); await press({ key: `${mod}+a` }); await press({ key: 'Backspace' }); await click({ role: 'button', name: 'Save binding' }); await browser({ args: ['wait', 'Preferences saved'] })
  await click({ role: 'button', name: 'Back to board' }); await focus({ selector: cardSelector }); await findPrevented({ expected: false })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'button', name: 'Rebind Find in current view' }); await fill({ role: 'textbox', name: 'One binding per line', text: 'Mod+f' }); await click({ role: 'button', name: 'Save binding' }); await browser({ args: ['wait', 'Preferences saved'] })
  await click({ role: 'button', name: 'Rebind Focus reply composer' }); await fill({ role: 'textbox', name: 'One binding per line', text: 'j' }); await click({ role: 'button', name: 'Save binding' }); await browser({ args: ['wait', 'Shortcut conflicts'] })
  await focus({ selector: "[aria-label='UI font size']" }); await press({ key: 'Escape' }); await check({ condition: active({ selector: "[aria-label='UI font size']" }) + " && document.querySelector('.keyboard-settings')", label: 'Escape in a number field stays in Settings' })
  await focus({ selector: '.binding-editor textarea' }); await press({ key: 'Escape' }); await check({ condition: "!document.querySelector('.binding-editor') && document.querySelector('.keyboard-settings')", label: 'Escape closes only the binding editor' })
  await click({ role: 'button', name: 'Rebind Focus reply composer' })
  await fill({ role: 'textbox', name: 'One binding per line', text: 'g r' }); await click({ role: 'button', name: 'Save binding' }); await browser({ args: ['wait', 'Preferences saved'] }); assert.deepEqual(board().view!.keyboard.bindings.reply, ['g r'])
  await fill({ role: 'searchbox', name: 'Filter shortcuts', text: 'reply' }); await browser({ args: ['eval', "() => { document.querySelector('.keyboard-settings').scrollIntoView(); return true; }"] }); await screenshot({ name: 'keyboard-settings.png' }); await click({ role: 'button', name: 'Back to board' }); await focus({ selector: cardSelector }); await press({ key: 'r' }); await check({ condition: "!document.querySelector('.detail')", label: 'old binding is disabled' })
  await press({ key: 'g' }); await press({ key: 'r' }); await browser({ args: ['wait', 'Reply to Shape the first working board'] }); await check({ condition: active({ selector: 'textarea' }), label: 'rebound sequence focuses reply' })
  await fill({ role: 'searchbox', name: 'Search board', text: 'Shape' })
  await browser({ args: ['eval', '() => { document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true; }'] })
  await check({ condition: `document.querySelector("[aria-label='Search board']").value === "" && ${active({ selector: "[aria-label='Search board']" })} && document.querySelector(".detail")`, label: 'Escape clears card search without native clearing' })
  await fill({ role: 'searchbox', name: 'Search board', text: 'Shape' }); await press({ key: 'Escape' })
  await check({ condition: `document.querySelector("[aria-label='Search board']").value === "" && ${active({ selector: "[aria-label='Search board']" })} && document.querySelector(".detail")`, label: 'Escape clears card search and keeps the detail open' })
  await press({ key: 'Escape' }); await check({ condition: active({ selector: '.composer textarea' }) + " && document.querySelector('.detail')", label: 'Escape in an empty search returns to its composer' })
  await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: '/' }); await browser({ args: ['wait', 'Search history'] }); await check({ condition: active({ selector: "[aria-label='Search history']" }), label: 'slash opens history search' })
  await click({ role: 'button', name: 'History' }); await press({ key: `${mod}+f` }); await check({ condition: active({ selector: "[aria-label='Search history']" }), label: 'Mod+F focuses history search' }); await findPrevented({ expected: true })
  await fill({ role: 'searchbox', name: 'Search history', text: 'hjkl / ? m' }); await press({ key: 'f' }); await check({ condition: "!document.querySelector('.hint-layer') && document.activeElement.value.endsWith('f')", label: 'search text never activates hints' })
  await press({ key: 'Escape' }); await check({ condition: active({ selector: "[aria-label='Search history']" }) + " && document.activeElement.value === ''", label: 'Escape clears history search natively' })
  await press({ key: 'Escape' }); await check({ condition: "!document.activeElement.matches('input') && document.querySelector('.history-page')", label: 'Escape leaves an empty history search without leaving History' }); await click({ role: 'button', name: 'Board' })
  await focus({ selector: cardSelector }); await press({ key: 'f' }); await check({ condition: "document.querySelectorAll('.target-hint').length > 10", label: 'visible targets get hint labels' }); await screenshot({ name: 'keyboard-hints.png' })
  // Choose the visible Settings target by its displayed label, with real keys.
  const hint = await browser({ args: ['eval', "() => { const target = [...document.querySelectorAll('.topbar nav button')].find(b => b.textContent === 'Settings').getBoundingClientRect(); const label = [...document.querySelectorAll('.target-hint')].find(h => Math.abs(parseFloat(h.style.left) - target.left) < 1 && Math.abs(parseFloat(h.style.top) - target.top) < 1); if (!label) throw new Error('Settings hint missing'); return 'LABEL:' + label.textContent; }"] })
  const keys = /LABEL:([asdfghjkl]+)/.exec(hint)![1]

  for (const key of keys) {
    await press({ key })
  }

  await browser({ args: ['wait', 'Keyboard shortcuts'] })
  await click({ role: 'switch', name: 'Character shortcuts' }); await browser({ args: ['wait', 'Preferences saved'] }); assert.equal(board().view!.keyboard.characterShortcuts, false)
  await click({ role: 'button', name: 'Back to board' }); await focus({ selector: cardSelector }); await press({ key: 'f' }); await check({ condition: "!document.querySelector('.hint-layer')", label: 'character keys can be disabled' }); await press({ key: `${mod}+k` }); await browser({ args: ['wait', 'Search board'] }); await press({ key: 'Escape' }); await check({ condition: active({ selector: cardSelector }), label: 'search restores its invoker' })
  await press({ key: `${mod}+f` }); await check({ condition: active({ selector: "[aria-label='Search board']" }), label: 'Mod+F works with character shortcuts disabled' }); await focus({ selector: cardSelector })
  await press({ key: `${mod}+,` }); await browser({ args: ['wait', 'Keyboard shortcuts'] }); await click({ role: 'switch', name: 'Character shortcuts' }); await browser({ args: ['wait', 'Preferences saved'] })
  await click({ role: 'button', name: 'Back to board' }); await browser({ args: ['open', server.url] }); await browser({ args: ['wait', 'Needs you'] }); await focus({ selector: cardSelector }); await press({ key: 'g' }); await press({ key: 'r' }); await browser({ args: ['wait', 'Reply to Shape the first working board'] }); await check({ condition: active({ selector: 'textarea' }), label: 'bindings survive reload' })
  await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Escape' })
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const columns = boardConfig({ state: w.state }).columns
      const d = hydraEvent({
        state: w.state,
        meta,
        cardId: '$board',
        change: { type: 'board.columns', data: { before: columns, columns: [...columns, { id: 'custom:later', title: 'Later' }] } },
      })
      assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  await browser({ args: ['wait', 'Later'] }); await focus({ selector: cardSelector })
  const columns = boardConfig({ state: board() }).columns
  const steps = columns.findIndex(c => c.id === 'custom:later') - columns.findIndex(c => c.id === board().cards[fixture.state.keys.layout!]!.column)

  for (let i = 0; i < steps; i++) {
    await press({ key: 'ArrowRight' })
  }

  await check({ condition: active({ selector: "[data-empty-column='custom:later']" }), label: 'empty columns remain keyboard reachable' })

  for (let i = 0; i < steps; i++) {
    await press({ key: 'ArrowLeft' })
  }

  await check({ condition: active({ selector: cardSelector }), label: 'empty column returns to remembered card' })
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decideMove({ state: w.state, ref: 'layout', column: 'parked', meta }); assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  await browser({ args: ['eval', `() => new Promise((resolve, reject) => { const observer = new MutationObserver(check); const timer = setTimeout(() => { observer.disconnect(); reject(new Error("source move not rendered")); }, 5000); function check() { if (document.querySelector(${JSON.stringify(cardSelector)}).closest("[data-column]").dataset.column === "parked") { clearTimeout(timer); observer.disconnect(); resolve(true); } } observer.observe(document.body, { subtree: true, childList: true }); check(); })`] }); await check({ condition: active({ selector: cardSelector }) + " && document.activeElement.closest('[data-column]').dataset.column === 'parked'", label: 'live move retains card focus' })
  await press({ key: '?' }); await browser({ args: ['wait', 'Keyboard help'] }); await press({ key: 'Escape' }); await check({ condition: active({ selector: cardSelector }), label: 'help restores board focus' })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'combobox', name: 'Conversation placement' }); await click({ role: 'option', name: 'Inline with cards' }); await click({ role: 'button', name: 'Back to board' })
  await focus({ selector: cardSelector }); await press({ key: 'Enter' }); await browser({ args: ['wait', 'Reply to Shape the first working board'] }); await check({ condition: active({ selector: '.composer textarea' }), label: 'inline conversation receives focus' })
  await press({ key: 'Escape' }); await press({ key: 'g' }); await press({ key: 'r' }); await fill({ role: 'textbox', name: 'Reply to Shape the first working board', text: 'Preserve inline draft' }); await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Escape' }); await check({ condition: active({ selector: cardSelector }), label: 'inline close restores card focus' })
  await press({ key: 'Enter' }); await click({ role: 'combobox', name: 'Workspace' }); await click({ role: 'option', name: 'Work' }); await browser({ args: ['wait', 'Outside current filters'] })
  await focus({ selector: '.thread' }); await press({ key: 'g' }); await press({ key: 'r' }); await check({ condition: "document.querySelector('.composer textarea').value === 'Preserve inline draft'", label: 'filtered conversation keeps draft' }); await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Escape' })
  await check({ condition: "document.activeElement.matches('[data-card]') && document.activeElement.closest('.card').querySelector('.workspace').textContent === 'Work'", label: 'filtered close finds a visible board anchor' })
  await browser({ args: ['emulate', '--viewport', '390x844x1,mobile,touch'] }); await press({ key: `${mod}+k` }); await browser({ args: ['wait', 'Search board'] })
  await check({ condition: "document.documentElement.scrollWidth === innerWidth && document.querySelector('.search-results').getBoundingClientRect().bottom <= innerHeight", label: 'mobile palette fits viewport and shows available actions' }); await screenshot({ name: 'keyboard-mobile.png' })
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Keyboard smoke passed; screenshots: ${evidence}\n`)
} finally {
  await server.close(); await browser({ args: ['stop'] }).catch(() => {}); rmSync(home, { recursive: true, force: true })
}
