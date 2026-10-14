// Real keyboard events against an isolated board and synthetic harness files.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '../src/server/server.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'
import { decideMove, decidePush, decideView } from '../src/core/decide.ts'
import { seedWebFixture } from './web-fixture.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const exec = promisify(execFile), home = mkdtempSync(join(tmpdir(), 'pnyx-keyboard-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture(home), cwd = join(home, 'project'), skill = join(cwd, '.claude/skills/review-local')
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

const browser = async (...args: string[]) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })

  if (/^error:/m.test(stdout)) {
    throw new Error(stdout)
  }

  return stdout
}

const check = async (condition: string, label: string) => {
  const out = await browser('eval', `() => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return "passed"; }`); assert.match(out, /passed/, label)
}

const ref = async (role: string, name: string) => {
  const snapshot = await browser('snapshot'), line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`)); assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async (role: string, name: string) => browser('click', await ref(role, name))
const fill = async (role: string, name: string, text: string) => browser('fill', await ref(role, name), text)
const press = (key: string) => browser('press', key)
const focus = (selector: string) => browser('eval', `() => { document.querySelector(${JSON.stringify(selector)}).focus(); return true; }`)
const active = (selector: string) => `document.activeElement.matches(${JSON.stringify(selector)})`
const cardSelector = `[data-card="${fixture.state.keys.layout}"]`
const board = () => loadBoard({ board: 'default' }).state

const screenshot = async (name: string) => {
  const path = join(evidence, name); rmSync(path, { force: true })

  try {
    await browser('screenshot', path)
  } catch (error) {
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

try {
  await browser('open', server.url); await browser('resize', '1440', '900'); await browser('wait', 'The working board')
  const platform = await browser('eval', "() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'"); const mod = platform.includes('mac') ? 'Meta' : 'Control'
  const findPrevented = (expected: boolean) => check(`(() => { const event = new KeyboardEvent('keydown', { key: 'f', ${mod === 'Meta' ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(event); return event.defaultPrevented === ${expected}; })()`, `browser find prevented: ${expected}`)
  await focus(cardSelector); await press(`${mod}+f`); await check(active("[aria-label='Find a card']"), 'Mod+F focuses board search')
  await fill('searchbox', 'Find a card', 'Shape'); await findPrevented(true); await check(active("[aria-label='Find a card']") + " && document.activeElement.value === 'Shape'", 'find in search preserves the query')
  await press('Escape')
  await focus(cardSelector)
  await browser('eval', "() => { document.querySelector(\"[aria-label='Find a card']\").disabled = true; return true; }")
  await findPrevented(false)
  await browser('eval', "() => { document.querySelector(\"[aria-label='Find a card']\").disabled = false; return true; }")
  await focus(cardSelector); await press('ArrowDown'); await check(active(`[data-card="${fixture.state.keys.coverage}"]`), 'down moves to next card')
  await press('k'); await check(active(cardSelector), 'k moves back'); await press('ArrowRight'); await check("document.activeElement.closest('[data-column]').dataset.column === 'workers_on_it'", 'right crosses columns')
  await press('h'); await check(active(cardSelector), 'left remembers column focus')
  await press('Enter'); await browser('wait', 'The first pass is ready to review.'); await check(active('.thread'), 'Enter focuses conversation')
  await press('r'); await check(active('.composer textarea'), 'r focuses composer')
  await press(`${mod}+f`); await check(active("[aria-label='Find a card']"), 'Mod+F leaves a text field for board search'); await focus('.composer textarea')
  await fill('textbox', 'Reply to Shape the first working board', 'hjkl / ? m'); await press('Enter'); await press('j')
  await check("document.querySelector('textarea').value === 'hjkl / ? m\\nj' && !document.querySelector('[role=dialog]')", 'typing stays literal')
  await press('Escape'); await check(active('.thread'), 'Escape leaves composer'); await press('Escape'); await check(active(cardSelector) + " && !document.querySelector('.detail')", 'Escape restores board focus')
  await press('r'); await browser('wait', 'Reply to Shape the first working board'); await check("document.querySelector('textarea').value === 'hjkl / ? m\\nj'", 'draft survives keyboard navigation')
  const beforeSlash = board().seq
  await fill('textbox', 'Reply to Shape the first working board', '/'); await browser('wait', '/review-local'); await screenshot('keyboard-slash.png')
  await press('ArrowDown'); await press('Enter'); await check("document.querySelector('textarea').value === '/review-local ' && !document.querySelector('.slash-menu')", 'completion inserts literal command'); assert.equal(board().seq, beforeSlash)
  await fill('textbox', 'Reply to Shape the first working board', '/rev'); await browser('wait', '/review-local'); await press('Escape'); await check(active('textarea') + " && !document.querySelector('.slash-menu')", 'Escape only closes suggestions')
  await fill('textbox', 'Reply to Shape the first working board', 'Keyboard fixture reply')
  await press(`${mod}+Enter`); await browser('wait', 'Delivered'); assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /Keyboard fixture reply/)
  const replyCount = board().cards[fixture.state.keys.layout!]!.replies!.length
  await fill('textbox', 'Reply to Shape the first working board', 'Keep this draft')
  await browser('eval', `() => { document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ${mod === 'Meta' ? 'metaKey' : 'ctrlKey'}: true, repeat: true, bubbles: true })); return true; }`)
  assert.equal(board().cards[fixture.state.keys.layout!]!.replies!.length, replyCount)
  await press('Escape'); await press('Escape')
  await press('m'); await browser('wait', 'Manual placement'); await fill('combobox', 'Search Move card', 'Done'); await press('Enter'); await browser('wait', 'Placement updated')
  assert.equal(board().cards[fixture.state.keys.layout!]!.column, 'done'); assert.equal(board().cards[fixture.state.keys.layout!]!.attention.length, 1)
  await check(active(cardSelector), 'moving a focused card follows its identity')
  const frames = () => browser('eval', '() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 50))))')

  for (const [query, title] of [['Keyboard help', 'Keyboard help'], ['Move card', 'Move card']]) {
    await press(`${mod}+k`); await browser('wait', 'Search Commands'); await fill('combobox', 'Search Commands', query); await press('Enter'); await browser('wait', `Search ${title}`); await frames()
    await check(`document.activeElement.matches("[aria-label='Search ${title}']")`, `palette hands focus to ${title}`)
    await press('Escape'); await frames(); await check(active(cardSelector), `${title} restores the card after the palette`)
  }

  await press(`${mod}+k`); await browser('wait', 'Search Commands'); await screenshot('keyboard-palette.png')
  await findPrevented(false)
  await fill('combobox', 'Search Commands', 'settings'); await press('Enter'); await browser('wait', 'Keyboard shortcuts')
  await findPrevented(false)
  await click('button', 'Rebind Find in current view'); await fill('textbox', 'One binding per line', 'Mod+g'); await click('button', 'Save binding'); await browser('wait', 'Preferences saved')
  assert.deepEqual(board().view!.keyboard.bindings.find, ['Mod+g'])
  await click('button', 'Back to board'); await focus(cardSelector); await findPrevented(false); await press(`${mod}+g`); await check(active("[aria-label='Find a card']"), 'find honors the custom binding')
  await click('button', 'Settings'); await click('button', 'Rebind Find in current view'); await press(`${mod}+a`); await press('Backspace'); await click('button', 'Save binding'); await browser('wait', 'Preferences saved')
  await click('button', 'Back to board'); await focus(cardSelector); await findPrevented(false)
  await click('button', 'Settings'); await click('button', 'Rebind Find in current view'); await fill('textbox', 'One binding per line', 'Mod+f'); await click('button', 'Save binding'); await browser('wait', 'Preferences saved')
  await click('button', 'Rebind Focus reply composer'); await fill('textbox', 'One binding per line', 'j'); await click('button', 'Save binding'); await browser('wait', 'Shortcut conflicts')
  await focus("[aria-label='Font size']"); await press('Escape'); await check(active("[aria-label='Font size']") + " && document.querySelector('.keyboard-settings')", 'Escape in a number field stays in Settings')
  await focus('.binding-editor textarea'); await press('Escape'); await check("!document.querySelector('.binding-editor') && document.querySelector('.keyboard-settings')", 'Escape closes only the binding editor')
  await click('button', 'Rebind Focus reply composer')
  await fill('textbox', 'One binding per line', 'g r'); await click('button', 'Save binding'); await browser('wait', 'Preferences saved'); assert.deepEqual(board().view!.keyboard.bindings.reply, ['g r'])
  await fill('searchbox', 'Filter shortcuts', 'reply'); await browser('eval', "() => { document.querySelector('.keyboard-settings').scrollIntoView(); return true; }"); await screenshot('keyboard-settings.png'); await click('button', 'Back to board'); await focus(cardSelector); await press('r'); await check("!document.querySelector('.detail')", 'old binding is disabled')
  await press('g'); await press('r'); await browser('wait', 'Reply to Shape the first working board'); await check(active('textarea'), 'rebound sequence focuses reply')
  await fill('searchbox', 'Find a card', 'Shape')
  await browser('eval', '() => { document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true; }')
  await check(`document.querySelector("[aria-label='Find a card']").value === "" && ${active("[aria-label='Find a card']")} && document.querySelector(".detail")`, 'Escape clears card search without native clearing')
  await fill('searchbox', 'Find a card', 'Shape'); await press('Escape')
  await check(`document.querySelector("[aria-label='Find a card']").value === "" && ${active("[aria-label='Find a card']")} && document.querySelector(".detail")`, 'Escape clears card search and keeps the detail open')
  await press('Escape'); await check(active(cardSelector) + " && document.querySelector('.detail')", 'Escape in an empty card search returns to the board')
  await press('Escape'); await press('Escape'); await press('/'); await browser('wait', 'Search history'); await check(active("[aria-label='Search history']"), 'slash opens history search')
  await click('button', 'History'); await press(`${mod}+f`); await check(active("[aria-label='Search history']"), 'Mod+F focuses history search'); await findPrevented(true)
  await fill('searchbox', 'Search history', 'hjkl / ? m'); await press('f'); await check("!document.querySelector('.hint-layer') && document.activeElement.value.endsWith('f')", 'search text never activates hints')
  await press('Escape'); await check(active("[aria-label='Search history']") + " && document.activeElement.value === ''", 'Escape clears history search natively')
  await press('Escape'); await check("!document.activeElement.matches('input') && document.querySelector('.history-page')", 'Escape leaves an empty history search without leaving History'); await click('button', 'Board')
  await focus(cardSelector); await press('f'); await check("document.querySelectorAll('.target-hint').length > 10", 'visible targets get hint labels'); await screenshot('keyboard-hints.png')
  // Choose the visible Settings target by its displayed label, with real keys.
  const hint = await browser('eval', "() => { const target = [...document.querySelectorAll('.topbar nav button')].find(b => b.textContent === 'Settings').getBoundingClientRect(); const label = [...document.querySelectorAll('.target-hint')].find(h => Math.abs(parseFloat(h.style.left) - target.left) < 1 && Math.abs(parseFloat(h.style.top) - target.top) < 1); if (!label) throw new Error('Settings hint missing'); return 'LABEL:' + label.textContent; }")
  const keys = /LABEL:([asdfghjkl]+)/.exec(hint)![1]

  for (const key of keys) {
    await press(key)
  }

  await browser('wait', 'Keyboard shortcuts')
  await click('switch', 'Character shortcuts'); await browser('wait', 'Preferences saved'); assert.equal(board().view!.keyboard.characterShortcuts, false)
  await click('button', 'Back to board'); await focus(cardSelector); await press('f'); await check("!document.querySelector('.hint-layer')", 'character keys can be disabled'); await press(`${mod}+k`); await browser('wait', 'Search Commands'); await press('Escape'); await check(active(cardSelector), 'palette restores its invoker')
  await press(`${mod}+f`); await check(active("[aria-label='Find a card']"), 'Mod+F works with character shortcuts disabled'); await focus(cardSelector)
  await press(`${mod}+,`); await browser('wait', 'Keyboard shortcuts'); await click('switch', 'Character shortcuts'); await browser('wait', 'Preferences saved')
  await click('button', 'Back to board'); await browser('open', server.url); await browser('wait', 'The working board'); await focus(cardSelector); await press('g'); await press('r'); await browser('wait', 'Reply to Shape the first working board'); await check(active('textarea'), 'bindings survive reload')
  await press('Escape'); await press('Escape')
  // Empty-column navigation and live moves use source events, not DOM edits.
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decideView({ state: w.state, patch: { customColumns: [{ id: 'custom:later', title: 'Later' }] }, meta }); assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  await browser('wait', 'Later'); await focus(cardSelector); await press('ArrowRight'); await check(active("[data-empty-column='custom:later']"), 'empty columns remain keyboard reachable'); await press('ArrowLeft'); await check(active(cardSelector), 'empty column returns to remembered card')
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decideMove({ state: w.state, ref: 'layout', column: 'review', meta }); assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  await browser('eval', `() => new Promise((resolve, reject) => { const observer = new MutationObserver(check); const timer = setTimeout(() => { observer.disconnect(); reject(new Error("source move not rendered")); }, 5000); function check() { if (document.querySelector(${JSON.stringify(cardSelector)}).closest("[data-column]").dataset.column === "review") { clearTimeout(timer); observer.disconnect(); resolve(true); } } observer.observe(document.body, { subtree: true, childList: true }); check(); })`); await check(active(cardSelector) + " && document.activeElement.closest('[data-column]').dataset.column === 'review'", 'live move retains card focus')
  await press('?'); await browser('wait', 'Keyboard help'); await press('Escape'); await check(active(cardSelector), 'help restores board focus')
  await click('button', 'Settings'); await click('combobox', 'Conversation placement'); await click('option', 'Inline with cards'); await click('button', 'Back to board')
  await focus(cardSelector); await press('Enter'); await browser('wait', 'Reply to Shape the first working board'); await check(active('.thread'), 'inline conversation receives focus')
  await press('g'); await press('r'); await fill('textbox', 'Reply to Shape the first working board', 'Preserve inline draft'); await press('Escape'); await press('Escape'); await check(active(cardSelector), 'inline close restores card focus')
  await press('Enter'); await click('combobox', 'Workspace'); await click('option', 'Work'); await browser('wait', 'Outside current filters')
  await focus('.thread'); await press('g'); await press('r'); await check("document.querySelector('textarea').value === 'Preserve inline draft'", 'filtered conversation keeps draft'); await press('Escape'); await press('Escape')
  await check("document.activeElement.matches('[data-card]') && document.activeElement.closest('.card').querySelector('.workspace').textContent === 'Work'", 'filtered close finds a visible board anchor')
  await browser('emulate', '--viewport', '390x844x1,mobile,touch'); await click('button', 'Commands'); await browser('wait', 'Search Commands')
  await check("document.documentElement.scrollWidth === innerWidth && document.querySelector('[role=dialog]').getBoundingClientRect().bottom <= innerHeight && !document.querySelector('[role=option][aria-disabled=true]')", 'mobile palette fits viewport and shows available actions'); await screenshot('keyboard-mobile.png')
  const consoleOutput = await browser('console'); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Keyboard smoke passed; screenshots: ${evidence}\n`)
} finally {
  await server.close(); await browser('stop').catch(() => {}); rmSync(home, { recursive: true, force: true })
}
