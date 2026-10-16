import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush } from '../src/core/decide.ts'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-composer-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const { browser, evaluate, check, eventually, click, text, fill, press, focus, screenshot, close } = smokeBrowser({ home, session: 'pnyx-composer' })
const state = () => loadHydra({ hydraId: 'default' }).state

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '900'] })
  await browser({ args: ['wait', 'Needs you'] })
  await check({ condition: 'document.querySelector(".hydra-chat .composer").getBoundingClientRect().height === 80 && document.querySelector(".hydra-chat textarea").clientHeight === 36 && getComputedStyle(document.querySelector(".hydra-chat .composer")).borderTopWidth === "0px"', label: 'composer rests at 36 px plus controls without a frame' })
  await screenshot({ name: 'composer-after.png' })
  await fill({ label: 'Reply to Hydra', value: 'First line\nSecond line\nThird line' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight > 80', label: 'draft grows with its content' })
  await fill({ label: 'Reply to Hydra', value: Array.from({ length: 30 }, (_, i) => `Line ${i}`).join('\n') })
  await eventually({ condition: 'document.querySelector(".hydra-chat textarea").clientHeight === 128', label: 'automatic draft growth stops at 128 px' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").scrollHeight > 128 && getComputedStyle(document.querySelector(".hydra-chat textarea")).overflowY === "auto"', label: 'long draft scrolls internally' })
  await screenshot({ name: 'composer-long.png' })
  await fill({ label: 'Reply to Hydra', value: '' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight === 80', label: 'empty draft shrinks again' })
  await focus({ selector: '.hydra-chat [aria-label="Resize composer"]' })
  await press({ key: 'End' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight > 172', label: 'composer resize can exceed automatic growth' })
  await check({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight <= Math.max(80, document.querySelector(".hydra-chat").clientHeight * .35)', label: 'manual composer height is capped at 35 percent of the pane' })
  assert.ok((state().view?.composerHeight ?? 0) > 172)
  await focus({ selector: '.hydra-chat [aria-label="Resize composer"]' })
  await press({ key: 'Home' })
  await click({ selector: '.hydra-chat [aria-label="Add to message"]' })
  await text({ label: 'Mention a task' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").value === "@" && document.activeElement.matches(".hydra-chat textarea")', label: 'plus inserts the task mention hook at the caret' })
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat input[type=file]"); const files = new DataTransfer(); files.items.add(new File(["const result = 42"], "example.ts", { type: "text/plain" })); input.files = files.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true;' })
  await eventually({ condition: 'document.querySelector(".hydra-chat textarea").value.includes("File: example.ts\\n\\nconst result = 42")', label: 'file contents enter the draft as real context' })
  await fill({ label: 'Reply to Hydra', value: '' })
  await click({ selector: '.hydra-chat [aria-label="Agent settings"]' })
  await screenshot({ name: 'composer-picker.png' })
  await check({ condition: '[...document.querySelectorAll(".hydra-chat .picker-field > span")].map(x => x.textContent).join(",") === "Agent,Model,Mode,Effort" && !document.querySelector(".hydra-chat [aria-label=Fast]")', label: 'single picker follows capability order and hides unsupported Fast' })
  await click({ selector: '.hydra-chat [aria-label=Agent]' })
  await click({ selector: '[role=listbox][aria-label=Agent] [role=option]:nth-child(2)' })
  assert.equal(state().config?.agents?.hydra, undefined)
  await press({ key: 'Escape' })
  await check({ condition: '!document.querySelector(".hydra-chat [role=dialog]") && document.activeElement.matches(".hydra-chat .agent-picker > button")', label: 'Escape discards staged settings and restores focus' })
  await click({ selector: '.hydra-chat [aria-label="Agent settings"]' })
  await check({ condition: 'document.querySelector(".hydra-chat [aria-label=Agent]").textContent.includes("Claude Code")', label: 'cancelled provider is not retained' })
  await press({ key: 'Escape' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({ condition: '!!document.querySelector(".detail .agent-picker")', label: 'attached session exposes the same picker' })
  await click({ selector: '.detail .agent-picker > button' })
  await check({ condition: 'document.querySelector(".detail .agent-configuration [aria-label=Agent]").disabled && document.querySelector(".detail .agent-configuration").textContent.includes("Hydra assigns agents")', label: 'settings cannot attach or reassign a task agent' })
  await evaluate({ code: 'window.agentRequests = []; const send = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { const message = JSON.parse(data); if (message.name === "agent") { window.agentRequests.push(message); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "result", id: message.id, agent: { sent: message.args[1] === window.failSetting ? "failed" : "delivered", confirmed: window.confirmAgent && message.args[1] !== window.failSetting, now: message.args[2] } }) })); return; } return send.call(this, data); }; return true;' })
  await click({ selector: '.detail .agent-configuration [aria-label=Effort]' })
  await click({ selector: '.detail [role=listbox][aria-label=Effort] [role=option]:nth-child(2)' })
  await check({ condition: 'window.agentRequests.length === 0', label: 'selecting a setting does not send it' })
  await text({ label: 'Apply settings' })
  await eventually({ condition: 'document.querySelector(".detail .agent-picker > button").textContent.includes("Pending confirmation")', label: 'unconfirmed delivery remains pending' })
  await click({ selector: '.detail .agent-picker > button' })
  await check({ condition: 'document.querySelector(".detail .agent-configuration [aria-label=Effort]").disabled && document.querySelector(".detail .agent-configuration [aria-label=Effort]").textContent.includes("Pending")', label: 'pending control awaits a real session report' })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({ state: writer.state, newCardId: 'unused', key: 'layout', input: { settings: { effort: 'low' } }, meta: { actor: 'fixture', at: new Date().toISOString() } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({ condition: '!document.querySelector(".detail .agent-picker > button").textContent.includes("Pending confirmation") && !document.querySelector(".detail .agent-configuration [aria-label=Effort]").disabled', label: 'session report confirms the setting' })
  await evaluate({ code: 'window.agentRequests = []; window.confirmAgent = true; window.failSetting = "effort"; return true;' })
  await click({ selector: '.detail .agent-configuration [aria-label=Mode]' })
  await click({ selector: '.detail [role=listbox][aria-label=Mode] [role=option]:nth-child(2)' })
  await click({ selector: '.detail .agent-configuration [aria-label=Effort]' })
  await evaluate({ code: 'const option = [...document.querySelectorAll(\'[role=listbox][aria-label=Effort] [role=option]\')].find(o => o.textContent.trim() === "high"); option.click(); return true;' })
  await text({ label: 'Apply settings' })
  await eventually({ condition: 'window.agentRequests.length === 2 && !document.querySelector(".detail .agent-configuration > button").disabled', label: 'failed setting stays staged after a successful earlier setting' })
  await evaluate({ code: 'window.failSetting = ""; return true;' })
  await text({ label: 'Apply settings' })
  await eventually({ condition: 'window.agentRequests.length === 3 && !document.querySelector(".detail [role=dialog]")', label: 'retry sends only the remaining setting' })
  await check({ condition: 'window.agentRequests.filter(message => message.args[1] === "mode").length === 1', label: 'a successfully delivered mode cycle is never repeated on retry' })
  await click({ selector: '[aria-label="Close detail"]' })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const config = hydraConfig({ state: writer.state })
      const decision = hydraEvent({ state: writer.state, cardId: '$board', meta: { actor: 'fixture', at: new Date().toISOString() }, change: { type: 'board.configured', data: { ...config, hydra: { id: 'fixture-firstmate', name: 'Hydra', kind: 'firstmate', home: fixture.nativeHome } } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({ condition: '!document.querySelector(".hydra-chat .agent-picker")', label: 'Firstmate-linked Hydra never offers its own agent settings' })
  await browser({ args: ['resize', '700', '500'] })
  await fill({ label: 'Reply to Hydra', value: 'A long draft\n'.repeat(30) })
  await check({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight <= Math.max(80, document.querySelector(".hydra-chat").clientHeight * .35)', label: 'short pane also caps automatic growth' })
  await screenshot({ name: 'composer-short.png' })
  await fill({ label: 'Reply to Hydra', value: 'Keep this draft.' })
  const beforeOversize = state().seq
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat input[type=file]"); const files = new DataTransfer(); for (const name of ["first.txt", "second.txt"]) files.items.add(new File(["x".repeat(40 * 1024)], name, { type: "text/plain" })); input.files = files.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true;' })
  await eventually({ condition: 'document.querySelector(".app > [role=status]")?.textContent.includes("Files and draft exceed")', label: 'aggregate insertion reports the message limit' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").value === "Keep this draft." && document.querySelector(".app").dataset.connected === "true"', label: 'aggregate file payload is rejected without replacing the draft or disconnecting' })
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "界".repeat(25 * 1024)); input.dispatchEvent(new Event("input", { bubbles: true })); return true;' })
  await click({ selector: '.hydra-chat .composer-send' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .reply-failure")?.textContent.includes("64 KiB")', label: 'oversized UTF-8 reply reports failure before transport' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").value.length === 25 * 1024 && document.querySelector(".app").dataset.connected === "true"', label: 'oversized draft stays intact and connected' })
  assert.equal(state().seq, beforeOversize)
  const consoleOutput = await browser({ args: ['console'] })
  assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught|ResizeObserver loop/)
  process.stdout.write('Composer and agent picker browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
