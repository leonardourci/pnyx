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

const seq = () => loadBoard('default').state.seq
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const oneEvent = async (from: number, label: string) => {
  for (let i = 0; i < 50 && seq() < from + 1; i++) {
    await sleep(100)
  }

  await sleep(500)
  assert.equal(seq(), from + 1, label)
}

const rapid = (selector: string, events: string) => browser('eval', `async () => { const el = document.querySelector(${JSON.stringify(selector)}); for (const e of ${events}) { await Promise.resolve(); el.dispatchEvent(e.startsWith("key") ? new KeyboardEvent(e.slice(0, e.indexOf(":")), { key: e.slice(e.indexOf(":") + 1), bubbles: true }) : new MouseEvent(e, { bubbles: true })); } return true; }`)
const view = () => loadBoard('default').state.view

try {
  await browser('open', server.url); await browser('resize', '1440', '900'); await browser('wait', 'The working board')
  await check('document.querySelectorAll("[data-card]").length === 6', 'fixture cards appear')
  await check('document.title === "(2) Board · Pnyx"', 'board tab title includes attention count')
  await check('await Promise.all([...document.querySelectorAll(\'link[rel="icon"],link[rel="apple-touch-icon"]\')].map(async link => { const response = await fetch(link.href); const blob = await response.blob(); const image = new Image(); image.src = URL.createObjectURL(blob); try { await image.decode(); return response.ok && (link.type === \'image/svg+xml\' ? blob.type === link.type : image.width === Number(link.sizes.value.split(\'x\')[0]) && image.height === image.width); } finally { URL.revokeObjectURL(image.src); } })).then(results => results.length === 4 && results.every(Boolean))', 'favicon and apple-touch assets load at their declared sizes')
  await screenshot('board.png')
  const beforeResize = loadBoard('default').state.seq
  await browser('eval', '() => { document.querySelector("[aria-label=\\"Resize Needs you column\\"]").focus(); return true; }')
  await browser('press', 'ArrowRight')
  await check('document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "298"', 'keyboard resize commits once')
  assert.equal(loadBoard('default').state.seq, beforeResize + 1)
  let from = seq()
  await rapid('[aria-label="Resize Needs you column"]', JSON.stringify(['keydown:ArrowRight', 'keyup:ArrowRight', 'keydown:ArrowRight', 'keyup:ArrowRight']))
  await oneEvent(from, 'a busy resize ignores a second press')
  assert.equal(view()?.columnWidths.needs_you, 306)
  await click('button', 'Shape the first working board'); await browser('wait', 'The first pass is ready to review.')
  await check('document.title === "(2) Shape the first working board · Pnyx"', 'open card appears in tab title')
  await check('!document.querySelector(".message.tool p") && document.querySelectorAll(".message.message p").length >= 3', 'messages visible and traces collapsed')
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
  await screenshot('settings.png'); await click('button', 'Back to board')
  await check('document.querySelector("textarea").value === "First line\\n"', 'draft survives settings')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), '/')
  await browser('wait', 'No working folder is recorded')
  await check('document.querySelector(".slash-menu").textContent.includes("No working folder")', 'slash catalog absence is explicit')
  await browser('press', 'Escape'); await check('!document.querySelector(".slash-menu") && document.querySelector("textarea").value === "/"', 'Escape preserves literal draft')
  await browser('fill', await ref('textbox', 'Reply to Shape the first working board'), 'The fixture layout looks good.'); await check('!document.querySelector(".composer [type=submit]").disabled', 'configured fixture route is available'); await click('button', 'Send reply'); await browser('wait', 'Delivered')
  assert.equal(loadBoard('default').state.cards[fixture.state.keys.layout!]!.replies?.at(-1)?.state, 'delivered')
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /The fixture layout looks good/)
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T11:00:00Z', message: { content: 'Live fixture update received.' } }) + '\n')
  await browser('wait', 'Live fixture update received.')
  await screenshot('conversation.png')
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
  assert.equal(loadBoard('default').state.view?.customColumns.at(-1)?.title, 'Later')
  await click('button', 'Shape the first working board'); await click('button', 'Why here / move'); await click('combobox', 'Move card'); await click('option', 'Later')
  await check('document.querySelector(".detail-content").textContent.includes("Pinned manually")', 'custom column move persists')
  assert.equal(loadBoard('default').state.cards[fixture.state.keys.layout!]!.attention.length, 1)
  await click('button', 'Conversation'); await browser('emulate', '--viewport', '390x844x1,mobile,touch'); await browser('wait', 'Later'); await click('button', 'Shape the first working board'); await browser('wait', 'Reply to Shape the first working board')
  await check('innerWidth === 390 && document.documentElement.scrollWidth === innerWidth && document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight', 'mobile composer stays in viewport')
  await screenshot('mobile.png')
  await click('button', 'History'); await browser('fill', await ref('searchbox', 'Search history'), 'conversation readable'); await browser('wait', 'Shape the first working board')
  await check('document.title === "(1) History · Pnyx"', 'history tab title uses the updated attention count')
  await check('document.querySelectorAll(".result-title").length === 1', 'full-text transcript search works')
  await browser('emulate', '--viewport', '1440x900x1'); await browser('wait', 'The working board'); await click('button', 'History'); await browser('fill', await ref('searchbox', 'Search history'), 'conversation readable'); await browser('wait', 'Shape the first working board'); await screenshot('history.png')
  await browser('open', server.url); await browser('wait', 'Later')
  assert.equal(loadBoard('default').state.view?.customColumns.length, 1)
  // Long unbroken metadata must reflow as the actual resize controls change size.
  const long = 'veryLongUnbrokenPathSegment'.repeat(8)
  const layoutMeta = { actor: 'fixture', at: '2026-10-14T11:00:00Z' }
  withWriter('default', w => {
    for (const decide of [
      () => decidePush(w.state, 'coverage', { workspace: long, tags: [long], attention: [{ kind: 'question', key: 'layout-width', blocking: true, text: `/src/${long}/file.ts\nconst result = ${long};\n| path | ${long} |` }] }, layoutMeta),
      () => decideLink(w.state, 'coverage', 'https://example.com/layout', { kind: 'url', url: 'https://example.com/layout', title: long }, layoutMeta),
    ]) {
      const d = decide()
      assert.ok('event' in d); w.append(d.event)
    }
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
  await resizeColumn('Home'); await check(`document.querySelector('.column-needs_you').getBoundingClientRect().width === 240 && ${fits}`, 'inline detail respects narrow column resize')
  await resizeColumn('End'); await check(`document.querySelector('.column-needs_you').getBoundingClientRect().width === 640 && ${fits}`, 'inline detail respects wide column resize')
  await browser('emulate', '--viewport', '390x844x1,mobile,touch'); await browser('wait', 'The working board')
  await check(`document.documentElement.scrollWidth === innerWidth && document.querySelector('.column-needs_you').getBoundingClientRect().width <= document.querySelector('.kanban').clientWidth && ${fits}`, 'wide column fits mobile viewport without internal horizontal scrolling')
  await screenshot('columns-mobile.png')
  const consoleOutput = await browser('console'); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Browser smoke passed; screenshots: ${evidence}\n`)
} finally {
  await server.close()
  await browser('stop').catch(() => {})
  rmSync(home, { recursive: true, force: true })
}
