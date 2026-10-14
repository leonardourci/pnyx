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
const fixture = seedWebFixture({ home })
const server = await startServer({ board: 'default', homes: [fixture.nativeHome] })
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-smoke-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence'); mkdirSync(evidence, { recursive: true })

const browser = async ({ args = [] }: { args?: string[] } = {}) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })

  if (/^error:/m.test(stdout)) {
    throw new Error(stdout)
  }

  return stdout
}

const screenshot = async ({ name }: { name: string }) => {
  await browser({ args: ['eval', '() => { [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "Dismiss notification")?.click(); return true; }'] })
  await browser({ args: ['eval', '() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'] })
  const path = join(evidence, name)
  rmSync(path, { force: true })

  try {
    await browser({ args: ['screenshot', path] })
  } catch (error) {
    // Some mobile-emulation versions save the PNG but omit its path in the MCP
    // reply. Accept only a newly created, valid image, never an older artifact.
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

const eventually = async ({ condition, label }: { condition: string; label: string }) => {
  const out = await browser({ args: ['eval', `async () => { for (let i = 0; i < 50; i++) { if (${condition}) return "passed"; await new Promise(r => setTimeout(r, 100)); } throw new Error(${JSON.stringify(label)}); }`] }); assert.match(out, /passed/, label)
}

const check = async ({ condition, label }: { condition: string; label: string }) => {
  const out = await browser({ args: ['eval', `async () => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return "passed"; }`] }); assert.match(out, /passed/, label)
}

const ref = async ({ role, name }: { role: string; name: string }) => {
  const snapshot = await browser({ args: ['snapshot'] }); const line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`)); assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async ({ role, name }: { role: string; name: string }) => {
  process.stdout.write(`Click ${role}: ${name}\n`)

  return browser({ args: ['click', await ref({ role, name })] })
}

const seq = () => loadBoard({ board: 'default' }).state.seq
const sleep = ({ ms }: { ms: number }) => new Promise(r => setTimeout(r, ms))

const oneEvent = async ({ from, label }: { from: number; label: string }) => {
  for (let i = 0; i < 50 && seq() < from + 1; i++) {
    await sleep({ ms: 100 })
  }

  await sleep({ ms: 500 })
  assert.equal(seq(), from + 1, label)
}

const rapid = ({ selector, events }: { selector: string; events: string }) => browser({ args: ['eval', `async () => { const el = document.querySelector(${JSON.stringify(selector)}); for (const e of ${events}) { await Promise.resolve(); el.dispatchEvent(e.startsWith("key") ? new KeyboardEvent(e.slice(0, e.indexOf(":")), { key: e.slice(e.indexOf(":") + 1), bubbles: true }) : new MouseEvent(e, { bubbles: true })); } return true; }`] })
const view = () => loadBoard({ board: 'default' }).state.view

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'The working board'] })
  await check({ condition: 'document.querySelectorAll("[data-card]").length === 6', label: 'fixture cards appear' })
  await check({ condition: 'document.title === "(2) Board · Pnyx"', label: 'board tab title includes attention count' })
  await check({ condition: 'await Promise.all([...document.querySelectorAll(\'link[rel="icon"],link[rel="apple-touch-icon"]\')].map(async link => { const response = await fetch(link.href); const blob = await response.blob(); const image = new Image(); image.src = URL.createObjectURL(blob); try { await image.decode(); return response.ok && (link.type === \'image/svg+xml\' ? blob.type === link.type : image.width === Number(link.sizes.value.split(\'x\')[0]) && image.height === image.width); } finally { URL.revokeObjectURL(image.src); } })).then(results => results.length === 4 && results.every(Boolean))', label: 'favicon and apple-touch assets load at their declared sizes' })
  await check({ condition: 'parseFloat(getComputedStyle(document.querySelector(".column-needs_you")).minWidth) >= 240 && parseFloat(getComputedStyle(document.querySelector(".card")).minWidth) >= 200 && parseFloat(getComputedStyle(document.querySelector(".card")).minHeight) >= 200', label: 'columns and cards keep readable minimum dimensions' })
  await eventually({ condition: '[...document.querySelectorAll(".last-message")].some(m => m.textContent.includes("The first pass is ready to review."))', label: "the card shows its conversation's last message" })
  await screenshot({ name: 'board.png' })
  // "readable" is only in the card's transcript, so only the server's full-text search finds it.
  await browser({ args: ['fill', await ref({ role: 'searchbox', name: 'Find a card' }), 'readable'] })
  await eventually({ condition: 'document.querySelectorAll("[data-card]").length === 1 && document.querySelector("[data-card]").textContent.includes("Shape the first working board")', label: 'the board search finds a card by its transcript' })
  await screenshot({ name: 'board-search.png' })
  await browser({ args: ['press', 'Escape'] })
  await eventually({ condition: 'document.querySelectorAll("[data-card]").length === 6', label: 'clearing the search shows every card' })
  await check({ condition: 'document.fonts.check(\'16px "Inter"\') && getComputedStyle(document.querySelector(".app")).fontFamily.startsWith("Inter")', label: 'the bundled UI font is used' })
  await browser({ args: ['emulate', '--color-scheme', 'dark'] }); await check({ condition: 'document.documentElement.dataset.theme === "dark"', label: 'System follows a dark operating system' })
  await screenshot({ name: 'board-dark.png' }); await browser({ args: ['emulate', '--color-scheme', 'auto'] })
  await browser({ args: ['eval', '() => { document.querySelector(".card .card-footer").click(); return true; }'] })
  await check({ condition: '!!document.querySelector(".detail")', label: 'clicking anywhere on a card opens it' })
  await click({ role: 'button', name: 'Close detail' })
  const beforeResize = loadBoard({ board: 'default' }).state.seq
  await browser({ args: ['eval', '() => { document.querySelector("[aria-label=\\"Resize Needs you column\\"]").focus(); return true; }'] })
  await browser({ args: ['press', 'ArrowRight'] })
  await check({ condition: 'document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "298"', label: 'keyboard resize commits once' })
  assert.equal(loadBoard({ board: 'default' }).state.seq, beforeResize + 1)
  let from = seq()
  await rapid({ selector: '[aria-label="Resize Needs you column"]', events: JSON.stringify(['keydown:ArrowRight', 'keyup:ArrowRight', 'keydown:ArrowRight', 'keyup:ArrowRight']) })
  await oneEvent({ from, label: 'a busy resize ignores a second press' })
  assert.equal(view()?.columnWidths.needs_you, 306)
  from = seq()
  await browser({ args: ['eval', '() => { const el = document.querySelector("[aria-label=\\"Resize Needs you column\\"]"); el.setPointerCapture = () => {}; el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 400, bubbles: true })); el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 0, bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, bubbles: true })); return true; }'] })
  await oneEvent({ from, label: 'drag resize clamps to the column minimum' })
  await check({ condition: 'document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "240"', label: 'drag resize cannot pass the column minimum' })
  await click({ role: 'button', name: 'Shape the first working board' }); await browser({ args: ['wait', 'Keep the conversation readable'] })
  await check({ condition: 'document.title === "(2) Shape the first working board · Pnyx"', label: 'open card appears in tab title' })
  await check({ condition: 'parseFloat(getComputedStyle(document.querySelector(".detail")).minWidth) >= 320 && parseFloat(getComputedStyle(document.querySelector(".detail")).minHeight) >= 280', label: 'conversation panel keeps readable minimum dimensions' })
  await check({ condition: '!document.querySelector(".message.tool p") && document.querySelectorAll(".message.message p").length >= 3', label: 'messages visible and traces collapsed' })
  await check({ condition: '![...document.querySelectorAll(".detail-tabs .button")].some(b => b.textContent === "Notes") && !document.querySelector(".conversation-brief").open && document.querySelector(".brief-line").textContent === "The first board layout is ready for review."', label: 'notes fold into a collapsed summary header instead of a tab' })
  await browser({ args: ['eval', '() => { document.querySelector(".conversation-brief > summary").click(); return true; }'] })
  await check({ condition: 'document.querySelectorAll(".conversation-brief .brief-item").length === 4 && getComputedStyle(document.querySelector(".message p")).fontFamily.startsWith("\\"Source Serif 4\\"")', label: 'the header lists each note once and chat text uses the chat font' })
  await screenshot({ name: 'notes-header.png' })
  await browser({ args: ['eval', '() => { document.querySelector(".conversation-brief > summary").click(); return true; }'] })
  await click({ role: 'switch', name: 'Tool details' }); await check({ condition: '!!document.querySelector(".message.tool p")', label: 'tool switch expands details' })
  const tools = () => view()?.cardTraceOverrides[fixture.state.keys.layout!]?.tools
  assert.equal(tools(), true)
  from = seq()
  await rapid({ selector: '[role=switch][aria-checked]', events: JSON.stringify(['click', 'click']) })
  await oneEvent({ from, label: 'a busy switch ignores a quick second toggle' })
  assert.equal(tools(), false)
  await check({ condition: 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "false"', label: 'switch shows the saved value' })
  await browser({ args: ['fill', await ref({ role: 'textbox', name: 'Reply to Shape the first working board' }), 'First line'] }); await browser({ args: ['press', 'Enter'] })
  await check({ condition: 'document.querySelector("textarea").value === "First line\\n"', label: 'Enter inserts a newline' })
  await click({ role: 'button', name: 'Settings' })
  await check({ condition: 'document.title === "(2) Settings · Pnyx"', label: 'settings tab title replaces selected card' })
  from = seq()
  await rapid({ selector: '[aria-label="Increase Panel width"]', events: JSON.stringify(['click', 'click']) })
  await oneEvent({ from, label: 'a busy number field ignores a quick second step' })
  assert.equal(view()?.panelWidth, 448)
  const panelWidthShown = "document.querySelector(\"input[aria-label='Panel width']\").value === \"448\""
  await browser({ args: ['eval', '() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (data) { const m = JSON.parse(data); if (m.name === "view" && window.rejectNext) { window.rejectNext = false; m.args[2] = JSON.stringify({ panelWidth: 9999 }); data = JSON.stringify(m); } return send.call(this, data); }; window.rejectNext = true; return true; }'] })
  from = seq()
  await rapid({ selector: '[aria-label="Increase Panel width"]', events: JSON.stringify(['click']) })
  await browser({ args: ['wait', 'invalid view preference'] })
  await check({ condition: panelWidthShown, label: 'a failed save stays at the saved value' })
  await browser({ args: ['eval', "() => { const state = Object.getOwnPropertyDescriptor(WebSocket.prototype, \"readyState\"); Object.defineProperty(WebSocket.prototype, \"readyState\", { configurable: true, get: () => WebSocket.CLOSED }); document.querySelector(\"[aria-label='Increase Panel width']\").click(); Object.defineProperty(WebSocket.prototype, \"readyState\", state); return true; }"] })
  await browser({ args: ['wait', 'The board is offline'] })
  await check({ condition: panelWidthShown, label: 'an offline save stays at the saved value' })
  assert.equal(seq(), from); assert.equal(view()?.panelWidth, 448)
  await screenshot({ name: 'settings.png' })
  await check({ condition: 'document.documentElement.dataset.theme === (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")', label: 'the System theme follows the operating system' })
  await browser({ args: ['emulate', '--color-scheme', 'light'] }); await check({ condition: 'document.documentElement.dataset.theme === "light"', label: 'System switches to light live' })
  await browser({ args: ['emulate', '--color-scheme', 'dark'] }); await check({ condition: 'document.documentElement.dataset.theme === "dark"', label: 'System switches to dark live' })
  await click({ role: 'combobox', name: 'Theme' }); await click({ role: 'option', name: 'Light' }); await browser({ args: ['wait', 'Preferences saved'] })
  await check({ condition: 'document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).backgroundColor === "rgb(245, 244, 240)"', label: 'an explicit Light theme overrides a dark system' })
  assert.equal(view()?.theme, 'light')
  await click({ role: 'button', name: 'Back to board' }); await screenshot({ name: 'board-light.png' }); await click({ role: 'button', name: 'Settings' })
  await click({ role: 'combobox', name: 'Theme' }); await click({ role: 'option', name: 'System' }); await browser({ args: ['wait', 'Preferences saved'] })
  await browser({ args: ['emulate', '--color-scheme', 'auto'] })
  await click({ role: 'button', name: 'Back to board' })
  await check({ condition: 'document.querySelector("textarea").value === "First line\\n"', label: 'draft survives settings' })
  await browser({ args: ['fill', await ref({ role: 'textbox', name: 'Reply to Shape the first working board' }), '/'] })
  await browser({ args: ['wait', 'No working folder is recorded'] })
  await check({ condition: 'document.querySelector(".slash-menu").textContent.includes("No working folder")', label: 'slash catalog absence is explicit' })
  await browser({ args: ['press', 'Escape'] }); await check({ condition: '!document.querySelector(".slash-menu") && document.querySelector("textarea").value === "/"', label: 'Escape preserves literal draft' })
  await browser({ args: ['fill', await ref({ role: 'textbox', name: 'Reply to Shape the first working board' }), 'The fixture layout looks good.'] }); await check({ condition: '!document.querySelector(".composer [type=submit]").disabled', label: 'configured fixture route is available' }); await click({ role: 'button', name: 'Send reply' }); await browser({ args: ['wait', 'Delivered'] })
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.replies?.at(-1)?.state, 'delivered')
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /The fixture layout looks good/)
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T11:00:00Z', message: { content: 'Live fixture update received.' } }) + '\n')
  await browser({ args: ['wait', 'Live fixture update received.'] })
  await eventually({ condition: '[...document.querySelectorAll(".last-message")].some(m => m.textContent.includes("Live fixture update received."))', label: "the card's last message follows the live transcript" })
  await screenshot({ name: 'conversation.png' })
  // The Agent tab changes a Firstmate task's settings by asking its orchestrator in a
  // request note, never by typing into the worker.
  const report = ({ settings, provider = 'claude-code' }: { settings: Record<string, string>; provider?: string }) => withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decidePush({ state: w.state, key: 'layout', input: { agent: { provider, sessionId: 'fixture-layout', transcriptPath: fixture.transcript }, settings }, meta: { actor: 'fixture', at: '2026-10-14T16:30:00Z' } })
      assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  report({ settings: { model: 'claude-sonnet-5-5', effort: 'medium', mode: 'default' } })
  await click({ role: 'button', name: 'Agent' }); await browser({ args: ['wait', 'Change from here'] })
  await check({ condition: '[...document.querySelectorAll(".control-row[aria-label=\'Permission mode\'] button")].every(b => !b.disabled && b.title.includes("request note"))', label: 'a key change is a request note too' })
  await check({ condition: 'document.querySelector(".agent-controls > p").textContent.includes("never types into the worker")', label: 'the tab says changes go to the orchestrator' })
  await check({ condition: 'document.querySelector(".control-row[aria-label=\'Effort\'] [aria-pressed=true]").textContent === "medium"', label: 'the reported effort is marked' })
  await click({ role: 'button', name: 'high' }); await browser({ args: ['wait', 'Waiting for the session to report its effort'] })
  await browser({ args: ['wait', 'asks Firstmate'] })
  const inbox = readFileSync(join(fixture.nativeHome, 'inbox.log'), 'utf8')
  assert.equal(inbox.match(/^arg=note$/gm)?.length, 1)
  assert.match(inbox, /^arg=Pnyx: please switch the worker on task api-v2 \(Claude Code\) to effort high\.\n---\n/m)
  report({ settings: { effort: 'high' } })
  await browser({ args: ['wait', 'Effort'] })
  await check({ condition: '!document.querySelector(".control-row[aria-label=\'Effort\'] p") && document.querySelector(".control-row[aria-label=\'Effort\'] [aria-pressed=true]").textContent === "high"', label: 'the session report confirms the change' })

  for (const scheme of ['light', 'dark']) {
    await browser({ args: ['emulate', '--color-scheme', scheme] }); await browser({ args: ['wait', 'Change from here'] })
    await check({ condition: 'getComputedStyle(document.querySelector(".segmented .button")).color !== getComputedStyle(document.querySelector(".segmented .button")).backgroundColor', label: `Agent tab controls stay legible with a ${scheme} system theme` })
    await screenshot({ name: `agent-${scheme}.png` })
  }

  report({ provider: 'codex', settings: { model: 'gpt-6-astra', approval: 'untrusted' } })
  await browser({ args: ['wait', 'gpt-6.1-sol'] })
  await check({ condition: '[...document.querySelectorAll(".control-row[aria-label=\'Model\'] button, .control-row[aria-label=\'Approval policy\'] button")].every(b => !b.disabled && b.title.includes("request note"))', label: 'Codex model and approval options are requests to Firstmate' })
  await screenshot({ name: 'codex-firstmate-settings.png' })
  const sentBefore = readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8')
  await click({ role: 'button', name: 'gpt-6.1-sol' }); await browser({ args: ['wait', 'Waiting for the session to report its model'] })
  await click({ role: 'button', name: 'on-request' }); await browser({ args: ['wait', 'Waiting for the session to report its approval policy'] })
  const codexInbox = readFileSync(join(fixture.nativeHome, 'inbox.log'), 'utf8')
  assert.match(codexInbox, /arg=Pnyx: please switch the worker on task api-v2 \(Codex\) to model gpt-6.1-sol\./)
  assert.match(codexInbox, /arg=Pnyx: please switch the worker on task api-v2 \(Codex\) to approval policy on-request\./)
  assert.equal(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), sentBefore)
  report({ provider: 'codex', settings: { model: 'gpt-6.1-sol', approval: 'on-request' } })
  await eventually({ condition: '!document.querySelector(".control-row[aria-label=\'Model\'] p") && !document.querySelector(".control-row[aria-label=\'Approval policy\'] p")', label: 'Codex reports confirm the requested settings' })

  await browser({ args: ['emulate', '--color-scheme', 'auto'] }); await browser({ args: ['wait', 'Change from here'] })
  await click({ role: 'button', name: 'Conversation' })
  await browser({ args: ['fill', await ref({ role: 'textbox', name: 'Reply to Shape the first working board' }), 'Keep this draft'] })
  await click({ role: 'combobox', name: 'Workspace' }); await click({ role: 'option', name: 'Work' })
  await check({ condition: 'document.querySelectorAll("[data-card]").length === 3 && document.querySelector(".detail").textContent.includes("Outside current filters")', label: 'workspace filters preserve the open conversation' })
  await click({ role: 'combobox', name: 'Workspace' }); await click({ role: 'option', name: 'All workspaces' })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'combobox', name: 'Conversation placement' }); await click({ role: 'option', name: 'Inline with cards' }); await click({ role: 'button', name: 'Back to board' })
  await check({ condition: '!!document.querySelector(".column-cards > .detail") && document.querySelector("textarea").value === "Keep this draft"', label: 'inline placement preserves drafts' })
  await screenshot({ name: 'inline.png' })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'combobox', name: 'Conversation placement' }); await click({ role: 'option', name: 'Right panel' }); await click({ role: 'button', name: 'Back to board' })
  await click({ role: 'button', name: 'Close detail' }); await click({ role: 'button', name: '+ Add column' }); await browser({ args: ['fill', await ref({ role: 'textbox', name: 'New column name' }), 'Discard me'] }); await browser({ args: ['press', 'Escape'] })
  await check({ condition: "!document.querySelector(\"[aria-label='New column name']\") && [...document.querySelectorAll(\"button\")].some(b => b.textContent === \"+ Add column\")", label: 'Escape dismisses the inline column form' })
  await click({ role: 'button', name: '+ Add column' }); await browser({ args: ['fill', await ref({ role: 'textbox', name: 'New column name' }), 'Later'] }); await click({ role: 'button', name: 'Create column' }); await browser({ args: ['wait', 'Later'] })
  assert.equal(loadBoard({ board: 'default' }).state.view?.customColumns.at(-1)?.title, 'Later')
  await click({ role: 'button', name: 'Shape the first working board' }); await click({ role: 'button', name: 'Why here / move' }); await click({ role: 'combobox', name: 'Move card' }); await click({ role: 'option', name: 'Later' })
  await check({ condition: 'document.querySelector(".detail-content").textContent.includes("Pinned manually")', label: 'custom column move persists' })
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.attention.length, 1)
  await click({ role: 'button', name: 'Conversation' }); await browser({ args: ['emulate', '--viewport', '390x844x1,mobile,touch'] }); await browser({ args: ['wait', 'Later'] })
  // On a phone the open panel can cover the card's centre, so open it by its own element.
  await browser({ args: ['eval', `() => { document.querySelector('[data-card="${fixture.state.keys.layout}"]').click(); return true }`] }); await browser({ args: ['wait', 'Reply to Shape the first working board'] })
  await check({ condition: 'innerWidth === 390 && document.documentElement.scrollWidth === innerWidth && document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight', label: 'mobile composer stays in viewport' })
  await screenshot({ name: 'mobile.png' })
  await click({ role: 'button', name: 'History' }); await browser({ args: ['fill', await ref({ role: 'searchbox', name: 'Search history' }), 'conversation readable'] }); await browser({ args: ['wait', 'Shape the first working board'] })
  await check({ condition: 'document.title === "(1) History · Pnyx"', label: 'history tab title uses the updated attention count' })
  await check({ condition: 'document.querySelectorAll(".result-title").length === 1', label: 'full-text transcript search works' })
  // The viewport change reloads the tab, which restores the open page.
  await browser({ args: ['emulate', '--viewport', '1440x900x1'] }); await browser({ args: ['wait', 'History'] }); await click({ role: 'button', name: 'History' }); await browser({ args: ['fill', await ref({ role: 'searchbox', name: 'Search history' }), 'conversation readable'] }); await browser({ args: ['wait', 'Shape the first working board'] }); await screenshot({ name: 'history.png' }); await click({ role: 'button', name: 'Board' })
  await browser({ args: ['open', server.url] }); await browser({ args: ['wait', 'Later'] })
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
  await browser({ args: ['wait', long] })
  const fits = "[...document.querySelectorAll('.column-cards,.card,.card-content')].every(el => el.scrollWidth <= el.clientWidth)"

  const resizeColumn = async ({ key }: { key: string }) => {
    await browser({ args: ['eval', '() => { const el = document.querySelector("[aria-label=\\"Resize Needs you column\\"]"); el.scrollIntoView({inline: "nearest"}); el.focus(); return true; }'] })
    await browser({ args: ['press', key] })
  }

  for (const [key, width] of [['Home', 240], ['End', 640], ['Home', 240], ['Shift+ArrowRight', 272]] as const) {
    await resizeColumn({ key })
    await check({ condition: `document.querySelector('.column-needs_you').getBoundingClientRect().width === ${width} && ${fits}`, label: `column and card content fit at ${width}px` })
  }

  await browser({ args: ['eval', `() => { document.querySelector('[data-card="${fixture.state.keys.coverage}"]').closest('.card').querySelector('.resize-y').focus(); return true; }`] })
  await browser({ args: ['press', 'Home'] }); await check({ condition: fits, label: 'short cards only scroll vertically' })
  await screenshot({ name: 'columns-narrow.png' })
  await browser({ args: ['press', 'End'] }); await check({ condition: fits, label: 'tall cards only scroll vertically' })
  await resizeColumn({ key: 'End' }); await screenshot({ name: 'columns-wide.png' })
  await click({ role: 'button', name: 'Settings' }); await click({ role: 'combobox', name: 'Conversation placement' }); await click({ role: 'option', name: 'Inline with cards' }); await click({ role: 'button', name: 'Back to board' })
  await click({ role: 'button', name: 'Check the empty-state experience' })
  await resizeColumn({ key: 'Home' }); await check({ condition: `document.querySelector('.column-needs_you').getBoundingClientRect().width === 340 && document.querySelector('.column-cards > .detail').getBoundingClientRect().width >= 320 && ${fits}`, label: 'inline detail keeps its readable minimum when the column is narrowed' })
  await resizeColumn({ key: 'End' }); await check({ condition: `document.querySelector('.column-needs_you').getBoundingClientRect().width === 640 && ${fits}`, label: 'inline detail respects wide column resize' })
  await browser({ args: ['emulate', '--viewport', '390x844x1,mobile,touch'] }); await browser({ args: ['wait', 'The working board'] })
  await check({ condition: `document.documentElement.scrollWidth === innerWidth && document.querySelector('.column-needs_you').getBoundingClientRect().width <= document.querySelector('.kanban').clientWidth && ${fits}`, label: 'wide column fits mobile viewport without internal horizontal scrolling' })
  await screenshot({ name: 'columns-mobile.png' })
  await browser({ args: ['emulate', '--viewport', '320x640x1,mobile,touch'] }); await browser({ args: ['wait', 'The working board'] })
  await check({ condition: `document.documentElement.scrollWidth === innerWidth && document.querySelector('.column-needs_you').getBoundingClientRect().width <= document.querySelector('.kanban').clientWidth && ${fits}`, label: 'inline detail column fits a 320px viewport without horizontal scrolling' })
  await browser({ args: ['emulate', '--viewport', '1440x900x1'] }); await browser({ args: ['wait', 'The working board'] })
  from = seq()
  await click({ role: 'button', name: 'Delete Later column' }); await screenshot({ name: 'column-delete.png' }); await click({ role: 'button', name: 'Delete column' }); await browser({ args: ['wait', 'Column deleted'] })
  await oneEvent({ from, label: 'deleting a column is one event' })
  assert.equal(loadBoard({ board: 'default' }).state.view?.customColumns.length, 0)
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.manualColumn, undefined)
  await click({ role: 'button', name: 'Undo' }); await browser({ args: ['wait', 'Column and its cards restored.'] })
  assert.equal(loadBoard({ board: 'default' }).state.cards[fixture.state.keys.layout!]!.manualColumn, loadBoard({ board: 'default' }).state.view?.customColumns[0]?.id)
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Browser smoke passed; screenshots: ${evidence}\n`)
} finally {
  await server.close()
  await browser({ args: ['stop'] }).catch(() => {})
  rmSync(home, { recursive: true, force: true })
}
