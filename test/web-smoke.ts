// Real browser smoke against a disposable board. Run with pnpm test:web.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '../src/server/server.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'
import { decideLink, decidePush } from '../src/core/decide.ts'
import { seedWebFixture } from './web-fixture.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const exec = promisify(execFile)
const home = mkdtempSync(join(tmpdir(), 'pnyx-web-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture(home)
const server = await startServer({ board: 'default', homes: [fixture.nativeHome] })
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-smoke-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence'); mkdirSync(evidence, { recursive: true })

const browser = async (...args: string[]) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })

  if (/^error:/m.test(stdout)) {
    throw new Error(stdout)
  }

  return stdout
}

const screenshot = async (name: string) => {
  await browser('eval', '() => { [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "Dismiss notification")?.click(); return true; }')
  await browser('eval', '() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const path = join(evidence, name)
  rmSync(path, { force: true })

  try {
    await browser('screenshot', path)
  } catch (error) {
    // Some mobile-emulation versions save the PNG but omit its path in the MCP
    // reply. Accept only a newly created, valid image, never an older artifact.
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

const eventually = async (condition: string, label: string) => {
  const out = await browser('eval', `async () => { for (let i = 0; i < 50; i++) { if (${condition}) return "passed"; await new Promise(r => setTimeout(r, 100)); } throw new Error(${JSON.stringify(label)}); }`); assert.match(out, /passed/, label)
}

const check = async (condition: string, label: string) => {
  const out = await browser('eval', `async () => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return "passed"; }`); assert.match(out, /passed/, label)
}

const ref = async (role: string, name: string) => {
  const snapshot = await browser('snapshot'); const line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`)); assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async (role: string, name: string) => {
  process.stdout.write(`Click ${role}: ${name}\n`)

  return browser('click', await ref(role, name))
}

const seq = () => loadBoard({ board: 'default' }).state.seq
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const oneEvent = async (from: number, label: string) => {
  for (let i = 0; i < 50 && seq() < from + 1; i++) {
    await sleep(100)
  }

  await sleep(500)
  assert.equal(seq(), from + 1, label)
}

const rapid = (selector: string, events: string) => browser('eval', `async () => { const el = document.querySelector(${JSON.stringify(selector)}); for (const e of ${events}) { await Promise.resolve(); el.dispatchEvent(e.startsWith("key") ? new KeyboardEvent(e.slice(0, e.indexOf(":")), { key: e.slice(e.indexOf(":") + 1), bubbles: true }) : new MouseEvent(e, { bubbles: true })); } return true; }`)
const view = () => loadBoard({ board: 'default' }).state.view

try {
  await browser('open', server.url); await browser('resize', '1440', '900'); await browser('wait', 'The working board')
  await check('document.querySelectorAll("[data-card]").length === 6', 'fixture cards appear')
  await check('document.title === "(2) Board · Pnyx"', 'board tab title includes attention count')
  await check('await Promise.all([...document.querySelectorAll(\'link[rel="icon"],link[rel="apple-touch-icon"]\')].map(async link => { const response = await fetch(link.href); const blob = await response.blob(); const image = new Image(); image.src = URL.createObjectURL(blob); try { await image.decode(); return response.ok && (link.type === \'image/svg+xml\' ? blob.type === link.type : image.width === Number(link.sizes.value.split(\'x\')[0]) && image.height === image.width); } finally { URL.revokeObjectURL(image.src); } })).then(results => results.length === 4 && results.every(Boolean))', 'favicon and apple-touch assets load at their declared sizes')
  await check('parseFloat(getComputedStyle(document.querySelector(".column-needs_you")).minWidth) >= 240 && parseFloat(getComputedStyle(document.querySelector(".card")).minWidth) >= 200 && parseFloat(getComputedStyle(document.querySelector(".card")).minHeight) >= 200', 'columns and cards keep readable minimum dimensions')
  await eventually('[...document.querySelectorAll(".last-message")].some(m => m.textContent.includes("The first pass is ready to review."))', "the card shows its conversation's last message")
  await screenshot('board.png')
  // "readable" is only in the card's transcript, so only the server's full-text search finds it.
  await browser('fill', await ref('searchbox', 'Find a card'), 'readable')
  await eventually('document.querySelectorAll("[data-card]").length === 1 && document.querySelector("[data-card]").textContent.includes("Shape the first working board")', 'the board search finds a card by its transcript')
  await screenshot('board-search.png')
  await browser('press', 'Escape')
  await eventually('document.querySelectorAll("[data-card]").length === 6', 'clearing the search shows every card')
  await check('document.fonts.check(\'16px "Inter"\') && getComputedStyle(document.querySelector(".app")).fontFamily.startsWith("Inter")', 'the bundled UI font is used')
  await browser('emulate', '--color-scheme', 'dark'); await check('document.documentElement.dataset.theme === "dark"', 'System follows a dark operating system')
  await screenshot('board-dark.png'); await browser('emulate', '--color-scheme', 'auto')
  await browser('eval', '() => { document.querySelector(".card .card-footer").click(); return true; }')
  await check('!!document.querySelector(".detail")', 'clicking anywhere on a card opens it')
  await click('button', 'Close detail')
  const beforeResize = loadBoard({ board: 'default' }).state.seq
  await browser('eval', '() => { document.querySelector("[aria-label=\\"Resize Needs you column\\"]").focus(); return true; }')
  await browser('press', 'ArrowRight')
  await check('document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "298"', 'keyboard resize commits once')
  assert.equal(loadBoard({ board: 'default' }).state.seq, beforeResize + 1)
  let from = seq()
  await rapid('[aria-label="Resize Needs you column"]', JSON.stringify(['keydown:ArrowRight', 'keyup:ArrowRight', 'keydown:ArrowRight', 'keyup:ArrowRight']))
  await oneEvent(from, 'a busy resize ignores a second press')
  assert.equal(view()?.columnWidths.needs_you, 306)
  from = seq()
  await browser('eval', '() => { const el = document.querySelector("[aria-label=\\"Resize Needs you column\\"]"); el.setPointerCapture = () => {}; el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 400, bubbles: true })); el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 0, bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, bubbles: true })); return true; }')
  await oneEvent(from, 'drag resize clamps to the column minimum')
  await check('document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "240"', 'drag resize cannot pass the column minimum')
  await click('button', 'Shape the first working board'); await browser('wait', 'Keep the conversation readable')
  await check('document.title === "(2) Shape the first working board · Pnyx"', 'open card appears in tab title')
  await check('parseFloat(getComputedStyle(document.querySelector(".detail")).minWidth) >= 320 && parseFloat(getComputedStyle(document.querySelector(".detail")).minHeight) >= 280', 'conversation panel keeps readable minimum dimensions')
  await check('!document.querySelector(".message.tool p") && document.querySelectorAll(".message.message p").length >= 3', 'messages visible and traces collapsed')
  await check('![...document.querySelectorAll(".detail-tabs .button")].some(b => b.textContent === "Notes") && !document.querySelector(".conversation-brief").open && document.querySelector(".brief-line").textContent === "The first board layout is ready for review."', 'notes fold into a collapsed summary header instead of a tab')
  await browser('eval', '() => { document.querySelector(".conversation-brief > summary").click(); return true; }')
  await check('document.querySelectorAll(".conversation-brief .brief-item").length === 4 && getComputedStyle(document.querySelector(".message p")).fontFamily.startsWith("\\"Source Serif 4\\"")', 'the header lists each note once and chat text uses the chat font')
  await screenshot('notes-header.png')
  await browser('eval', '() => { document.querySelector(".conversation-brief > summary").click(); return true; }')
  await click('switch', 'Tool details'); await check('!!document.querySelector(".message.tool p")', 'tool switch expands details')
  const tools = () => view()?.cardTraceOverrides[fixture.state.keys.layout!]?.tools
  assert.equal(tools(), true)
  from = seq()
  await rapid('[role=switch][aria-checked]', JSON.stringify(['click', 'click']))
  await oneEvent(from, 'a busy switch ignores a quick second toggle')
  assert.equal(tools(), false)
  await check('document.querySelector("[role=switch]").getAttribute("aria-checked") === "false"', 'switch shows the saved value')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), 'First line'); await browser('press', 'Enter')
  await check('document.querySelector("textarea").value === "First line\\n"', 'Enter inserts a newline')
  await click('button', 'Settings')
  await check('document.title === "(2) Settings · Pnyx"', 'settings tab title replaces selected card')
  from = seq()
  await rapid('[aria-label="Increase Panel width"]', JSON.stringify(['click', 'click']))
  await oneEvent(from, 'a busy number field ignores a quick second step')
  assert.equal(view()?.panelWidth, 448)
  const panelWidthShown = "document.querySelector(\"input[aria-label='Panel width']\").value === \"448\""
  await browser('eval', '() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { const m = JSON.parse(data); if (m.name === "view" && window.rejectNext) { window.rejectNext = false; m.args[2] = JSON.stringify({ panelWidth: 9999 }); data = JSON.stringify(m); } return send.call(this, data); }; window.rejectNext = true; return true; }')
  from = seq()
  await rapid('[aria-label="Increase Panel width"]', JSON.stringify(['click']))
  await browser('wait', 'invalid view preference')
  await check(panelWidthShown, 'a failed save stays at the saved value')
  await browser('eval', "() => { const state = Object.getOwnPropertyDescriptor(WebSocket.prototype, \"readyState\"); Object.defineProperty(WebSocket.prototype, \"readyState\", { configurable: true, get: () => WebSocket.CLOSED }); document.querySelector(\"[aria-label='Increase Panel width']\").click(); Object.defineProperty(WebSocket.prototype, \"readyState\", state); return true; }")
  await browser('wait', 'The board is offline')
  await check(panelWidthShown, 'an offline save stays at the saved value')
  assert.equal(seq(), from); assert.equal(view()?.panelWidth, 448)
  await screenshot('settings.png')
  await check('document.documentElement.dataset.theme === (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")', 'the System theme follows the operating system')
  await browser('emulate', '--color-scheme', 'light'); await check('document.documentElement.dataset.theme === "light"', 'System switches to light live')
  await browser('emulate', '--color-scheme', 'dark'); await check('document.documentElement.dataset.theme === "dark"', 'System switches to dark live')
  await click('combobox', 'Theme'); await click('option', 'Light'); await browser('wait', 'Preferences saved')
  await check('document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).backgroundColor === "rgb(245, 244, 240)"', 'an explicit Light theme overrides a dark system')
  assert.equal(view()?.theme, 'light')
  await click('button', 'Back to board'); await screenshot('board-light.png'); await click('button', 'Settings')
  await click('combobox', 'Theme'); await click('option', 'System'); await browser('wait', 'Preferences saved')
  await browser('emulate', '--color-scheme', 'auto')
  await click('button', 'Back to board')
  await check('document.querySelector("textarea").value === "First line\\n"', 'draft survives settings')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), '/')
  await browser('wait', 'No working folder is recorded')
  await check('document.querySelector(".slash-menu").textContent.includes("No working folder")', 'slash catalog absence is explicit')
  await browser('press', 'Escape'); await check('!document.querySelector(".slash-menu") && document.querySelector("textarea").value === "/"', 'Escape preserves literal draft')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), 'The fixture layout looks good.'); await check('!document.querySelector(".composer [type=submit]").disabled', 'configured fixture route is available'); await click('button', 'Send reply'); await browser('wait', 'Delivered')
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.replies?.at(-1)?.state, 'delivered')
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /The fixture layout looks good/)
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T11:00:00Z', message: { content: 'Live fixture update received.' } }) + '\n')
  await browser('wait', 'Live fixture update received.')
  await eventually('[...document.querySelectorAll(".last-message")].some(m => m.textContent.includes("Live fixture update received."))', "the card's last message follows the live transcript")
  await screenshot('conversation.png')
  // The Agent tab changes a Firstmate task's settings by asking its orchestrator in a
  // request note, never by typing into the worker.
  const report = (settings: Record<string, string>) => withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decidePush({ state: w.state, key: 'layout', input: { agent: { provider: 'claude-code', sessionId: 'fixture-layout', transcriptPath: fixture.transcript }, settings }, meta: { actor: 'fixture', at: '2026-10-14T16:30:00Z' } })
      assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  report({ model: 'claude-sonnet-5-5', effort: 'medium', mode: 'default' })
  await click('button', 'Agent'); await browser('wait', 'Change from here')
  await check('[...document.querySelectorAll(".control-row[aria-label=\'Permission mode\'] button")].every(b => !b.disabled && b.title.includes("request note"))', 'a key change is a request note too')
  await check('document.querySelector(".agent-controls > p").textContent.includes("never types into the worker")', 'the tab says changes go to the orchestrator')
  await browser('wait', 'No request notes yet')
  await check('document.querySelector(".control-row[aria-label=\'Effort\'] [aria-pressed=true]").textContent === "medium"', 'the reported effort is marked')
  await click('button', 'high'); await browser('wait', 'Waiting for the session to report its effort')
  await browser('wait', 'asks Firstmate')
  // The tab reloads the notes' receipts after the reply lands, so the note need not be last.
  const inbox = readFileSync(join(fixture.nativeHome, 'inbox.log'), 'utf8')
  assert.equal(inbox.match(/^arg=note$/gm)?.length, 1)
  assert.match(inbox, /^arg=Pnyx: please switch the worker on task api-v2 \(Claude Code\) to effort high\.\n---\n/m)
  await browser('wait', 'queued')
  report({ effort: 'high' })
  await browser('wait', 'Effort')
  await check('!document.querySelector(".control-row[aria-label=\'Effort\'] p") && document.querySelector(".control-row[aria-label=\'Effort\'] [aria-pressed=true]").textContent === "high"', 'the session report confirms the change')

  for (const scheme of ['light', 'dark']) {
    await browser('emulate', '--color-scheme', scheme); await browser('wait', 'Change from here')
    await check('getComputedStyle(document.querySelector(".segmented .button")).color !== getComputedStyle(document.querySelector(".segmented .button")).backgroundColor', `Agent tab controls stay legible with a ${scheme} system theme`)
    await screenshot(`agent-${scheme}.png`)
  }

  await browser('emulate', '--color-scheme', 'auto'); await browser('wait', 'Change from here')
  await click('button', 'Conversation')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), 'Keep this draft')
  await click('combobox', 'Workspace'); await click('option', 'Work')
  await check('document.querySelectorAll("[data-card]").length === 3 && document.querySelector(".detail").textContent.includes("Outside current filters")', 'workspace filters preserve the open conversation')
  await click('combobox', 'Workspace'); await click('option', 'All workspaces')
  await click('button', 'Settings'); await click('combobox', 'Conversation placement'); await click('option', 'Inline with cards'); await click('button', 'Back to board')
  await check('!!document.querySelector(".column-cards > .detail") && document.querySelector("textarea").value === "Keep this draft"', 'inline placement preserves drafts')
  await screenshot('inline.png')
  await click('button', 'Settings'); await click('combobox', 'Conversation placement'); await click('option', 'Right panel'); await click('button', 'Back to board')
  await click('button', 'Close detail'); await click('button', '+ Add column'); await browser('fill', await ref('textbox', 'New column name'), 'Discard me'); await browser('press', 'Escape')
  await check("!document.querySelector(\"[aria-label='New column name']\") && [...document.querySelectorAll(\"button\")].some(b => b.textContent === \"+ Add column\")", 'Escape dismisses the inline column form')
  await click('button', '+ Add column'); await browser('fill', await ref('textbox', 'New column name'), 'Later'); await click('button', 'Create column'); await browser('wait', 'Later')
  assert.equal(loadBoard({ board: 'default' }).state.view?.customColumns.at(-1)?.title, 'Later')
  await click('button', 'Shape the first working board'); await click('button', 'Why here / move'); await click('combobox', 'Move card'); await click('option', 'Later')
  await check('document.querySelector(".detail-content").textContent.includes("Pinned manually")', 'custom column move persists')
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.attention.length, 1)
  await click('button', 'Conversation'); await browser('emulate', '--viewport', '390x844x1,mobile,touch'); await browser('wait', 'Later')
  // On a phone the open panel can cover the card's centre, so open it by its own element.
  await browser('eval', `() => { document.querySelector('[data-card="${fixture.state.keys.layout}"]').click(); return true }`); await browser('wait', 'Reply to Shape the first working board')
  await check('innerWidth === 390 && document.documentElement.scrollWidth === innerWidth && document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight', 'mobile composer stays in viewport')
  await screenshot('mobile.png')
  await click('button', 'History'); await browser('fill', await ref('searchbox', 'Search history'), 'conversation readable'); await browser('wait', 'Shape the first working board')
  await check('document.title === "(1) History · Pnyx"', 'history tab title uses the updated attention count')
  await check('document.querySelectorAll(".result-title").length === 1', 'full-text transcript search works')
  // The viewport change reloads the tab, which restores the open page.
  await browser('emulate', '--viewport', '1440x900x1'); await browser('wait', 'History'); await click('button', 'History'); await browser('fill', await ref('searchbox', 'Search history'), 'conversation readable'); await browser('wait', 'Shape the first working board'); await screenshot('history.png'); await click('button', 'Board')
  await browser('open', server.url); await browser('wait', 'Later')
  assert.equal(loadBoard({ board: 'default' }).state.view?.customColumns.length, 1)
  // Long unbroken metadata must reflow as the actual resize controls change size.
  const long = 'veryLongUnbrokenPathSegment'.repeat(8)
  const layoutMeta = { actor: 'fixture', at: '2026-10-14T11:00:00Z' }
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      for (const decide of [
        () => decidePush({ state: w.state, key: 'coverage', input: { workspace: long, tags: [long], attention: [{ kind: 'question', key: 'layout-width', blocking: true, text: `/src/${long}/file.ts\nconst result = ${long};\n| path | ${long} |` }] }, meta: layoutMeta }),
        () => decideLink({ state: w.state, ref: 'coverage', url: 'https://example.com/layout', link: { kind: 'url', url: 'https://example.com/layout', title: long }, meta: layoutMeta }),
      ]) {
        const d = decide()
        assert.ok('event' in d); w.append({ event: d.event })
      }
    },
  })
  await browser('wait', long)
  const fits = "[...document.querySelectorAll('.column-cards,.card,.card-content')].every(el => el.scrollWidth <= el.clientWidth)"

  const resizeColumn = async (key: string) => {
    await browser('eval', '() => { const el = document.querySelector("[aria-label=\\"Resize Needs you column\\"]"); el.scrollIntoView({inline: "nearest"}); el.focus(); return true; }')
    await browser('press', key)
  }

  for (const [key, width] of [['Home', 240], ['End', 640], ['Home', 240], ['Shift+ArrowRight', 272]] as const) {
    await resizeColumn(key)
    await check(`document.querySelector('.column-needs_you').getBoundingClientRect().width === ${width} && ${fits}`, `column and card content fit at ${width}px`)
  }

  await browser('eval', `() => { document.querySelector('[data-card="${fixture.state.keys.coverage}"]').closest('.card').querySelector('.resize-y').focus(); return true; }`)
  await browser('press', 'Home'); await check(fits, 'short cards only scroll vertically')
  await screenshot('columns-narrow.png')
  await browser('press', 'End'); await check(fits, 'tall cards only scroll vertically')
  await resizeColumn('End'); await screenshot('columns-wide.png')
  await click('button', 'Settings'); await click('combobox', 'Conversation placement'); await click('option', 'Inline with cards'); await click('button', 'Back to board')
  await click('button', 'Check the empty-state experience')
  await resizeColumn('Home'); await check(`document.querySelector('.column-needs_you').getBoundingClientRect().width === 340 && document.querySelector('.column-cards > .detail').getBoundingClientRect().width >= 320 && ${fits}`, 'inline detail keeps its readable minimum when the column is narrowed')
  await resizeColumn('End'); await check(`document.querySelector('.column-needs_you').getBoundingClientRect().width === 640 && ${fits}`, 'inline detail respects wide column resize')
  await browser('emulate', '--viewport', '390x844x1,mobile,touch'); await browser('wait', 'The working board')
  await check(`document.documentElement.scrollWidth === innerWidth && document.querySelector('.column-needs_you').getBoundingClientRect().width <= document.querySelector('.kanban').clientWidth && ${fits}`, 'wide column fits mobile viewport without internal horizontal scrolling')
  await screenshot('columns-mobile.png')
  await browser('emulate', '--viewport', '320x640x1,mobile,touch'); await browser('wait', 'The working board')
  await check(`document.documentElement.scrollWidth === innerWidth && document.querySelector('.column-needs_you').getBoundingClientRect().width <= document.querySelector('.kanban').clientWidth && ${fits}`, 'inline detail column fits a 320px viewport without horizontal scrolling')
  await browser('emulate', '--viewport', '1440x900x1'); await browser('wait', 'The working board')
  from = seq()
  await click('button', 'Delete Later column'); await screenshot('column-delete.png'); await click('button', 'Delete column'); await browser('wait', 'Column deleted')
  await oneEvent(from, 'deleting a column is one event')
  assert.equal(loadBoard({ board: 'default' }).state.view?.customColumns.length, 0)
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.manualColumn, undefined)
  await click('button', 'Undo'); await browser('wait', 'Column and its cards restored.')
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.manualColumn, loadBoard({ board: 'default' }).state.view?.customColumns[0]?.id)
  const consoleOutput = await browser('console'); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Browser smoke passed; screenshots: ${evidence}\n`)
} finally {
  await server.close()
  await browser('stop').catch(() => {})
  rmSync(home, { recursive: true, force: true })
}
