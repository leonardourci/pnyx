import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadBoard } from '../src/store/board-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-layout-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const server = await startServer({ board: 'default', homes: [fixture.nativeHome] })
const { browser, check, eventually, click, text, fill, press, focus, screenshot, close, evaluate } = smokeBrowser({ home, session: 'pnyx-layout' })
const state = () => loadBoard({ board: 'default' }).state

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'Needs you'] })
  await check({ condition: 'document.querySelectorAll("[data-card]").length === 6 && !document.querySelector(".toolbar,.keyboard-toolbar,.notice,.detail-tabs")', label: 'compact board has no extra toolbar or overlays' })
  await check({ condition: 'document.querySelector(".hydra-chat").getBoundingClientRect().height === document.querySelector(".column").getBoundingClientRect().height && document.querySelector(".hydra-head").textContent === "Hydra"', label: 'Hydra and columns fill the board height' })
  await check({ condition: 'document.querySelector(".card").getBoundingClientRect().height < 150 && !document.querySelector(".card .setting-chip,.card .tags,.card .links,.card .resize")', label: 'cards size to their titles and agent activity' })
  await check({ condition: '!document.querySelector(".last-message")', label: 'last messages are off by default' })
  await screenshot({ name: 'board.png' })
  await text({ label: 'Settings' }); await click({ selector: '[aria-label="Last message on cards"]' })
  await eventually({ condition: 'document.querySelector("[aria-label=\\"Last message on cards\\"]").getAttribute("aria-checked") === "true"', label: 'card setting saved' })
  await click({ selector: '[aria-label="Switch board"]' }); await click({ selector: '[aria-current="page"]' })
  await eventually({ condition: '!!document.querySelector(".last-message")', label: 'optional last message displayed' })
  await check({ condition: '!!document.querySelector("[data-search-slot] input") && !document.querySelector(".board-list")', label: 'board switcher returns to the board' })
  await fill({ label: 'Find a card', value: 'readable' })
  await eventually({ condition: 'document.querySelectorAll("[data-card]").length === 1', label: 'search filters board from transcript matches' })
  await text({ label: 'History' }); await fill({ label: 'Search history', value: 'Document the reply receipts' })
  await eventually({ condition: '!!document.querySelector(".history-page .result-title")', label: 'History result loaded outside the board filter' })
  await click({ selector: '.history-page .result-title' })
  await check({ condition: 'document.querySelector(".card.selected").textContent.includes("Document the reply receipts") && !!document.querySelector(".card.selected .detail")', label: 'opening a History result reveals it despite a conflicting board query' })
  await click({ selector: '[aria-label="Close detail"]' })
  await focus({ selector: '[aria-label="Find a card"]' }); await press({ key: 'Escape' })
  await eventually({ condition: 'document.querySelectorAll("[data-card]").length === 6', label: 'Escape restores unfiltered board' })
  await evaluate({ code: 'window.columnWidth = document.querySelector(".column").getBoundingClientRect().width; return true;' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await browser({ args: ['wait', 'Keep the conversation readable'] })
  await check({ condition: '!!document.querySelector(".card.selected > .detail") && document.querySelector(".column").getBoundingClientRect().width === window.columnWidth && !document.querySelector(".detail-tabs,.conversation-brief,.thread-controls")', label: 'card opens downward without changing the column width' })
  await check({ condition: 'document.activeElement.matches(".detail .composer textarea") && document.querySelectorAll(".detail .agent-chip").length === 1 && !document.querySelector(".detail .message.tool")', label: 'open card has one agent chip and its own composer' })
  await screenshot({ name: 'card-open.png' })
  await click({ selector: '[aria-label="Close detail"]' })
  await focus({ selector: '[aria-label="Resize Hydra panel"]' }); await press({ key: 'ArrowRight' })
  await eventually({ condition: 'document.querySelector("[aria-label=\\"Resize Hydra panel\\"]").getAttribute("aria-valuenow") === "388"', label: 'Hydra resize is saved' })
  assert.equal(state().view?.hydraWidth, 388)
  await focus({ selector: '[aria-label="Resize Needs you column"]' }); await press({ key: 'ArrowRight' })
  await eventually({ condition: 'document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "298"', label: 'column resize saved' })
  await text({ label: 'Settings' })
  await check({ condition: 'Math.abs(document.querySelector(".settings").getBoundingClientRect().left - (innerWidth - document.querySelector(".settings").getBoundingClientRect().width) / 2) < 2 && document.querySelectorAll(".settings-grid > .settings-box").length >= 5', label: 'settings uses one centered readable column' })
  await click({ selector: '[aria-label="Focus mode"]' })
  await eventually({ condition: 'document.querySelector("[aria-label=\\"Focus mode\\"]").getAttribute("aria-checked") === "false"', label: 'Focus can be disabled separately' })
  const beforeReset = state().seq
  await text({ label: 'Reset widths to defaults' })
  await eventually({ condition: 'document.querySelector(".app").dataset.seq === ' + JSON.stringify(String(beforeReset + 1)), label: 'width defaults restored' })
  assert.equal(state().view?.hydraWidth, 380)
  assert.equal(state().view?.columnWidths.needs_you, 290)
  await click({ selector: '[aria-label="Switch board"]' }); await click({ selector: '[aria-current="page"]' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` }); await browser({ args: ['wait', 'Keep the conversation readable'] })
  await check({ condition: '!!document.querySelector(".detail .message.tool") && document.querySelector(".detail .trace").dataset.expandable === "false"', label: 'details off keeps tool rows visible and collapsed' })
  await check({ condition: '!document.querySelector(".detail .trace summary,.detail .trace pre")', label: 'disabled details do not expand' })
  await evaluate({ code: 'const send = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { const m = JSON.parse(data); if (m.name === "reply") { m.args[0] = "missing-card"; data = JSON.stringify(m); } return send.call(this, data); }; return true;' })
  await fill({ label: 'Reply to Shape the first working board', value: 'Retain this failed reply' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: '!!document.querySelector(".detail .reply-failure")', label: 'failed reply shows a short line in the conversation' })
  await check({ condition: 'document.querySelector(".detail .composer textarea").value === "Retain this failed reply"', label: 'failed reply keeps the draft' })
  await browser({ args: ['emulate', '--color-scheme', 'dark'] }); await screenshot({ name: 'board-dark.png' })
  await browser({ args: ['resize', '700', '800'] })
  await check({ condition: 'document.querySelector(".hydra-chat").getBoundingClientRect().height > 600 && document.querySelector(".kanban").scrollWidth > document.querySelector(".kanban").clientWidth', label: 'narrow windows keep Hydra docked with horizontal overflow' })
  process.stdout.write('Layout browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
