import { effectiveDispatch } from '../src/dispatch/config.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  await check({ condition: 'document.querySelector(".hydra-chat .composer").getBoundingClientRect().height >= 80 && document.querySelector(".hydra-chat textarea").clientHeight === 36 && getComputedStyle(document.querySelector(".hydra-chat .composer")).borderTopWidth === "0px"', label: 'composer rests at 36 px plus controls without a frame' })
  await evaluate({ code: 'window.composerRest = document.querySelector(".hydra-chat .composer").clientHeight; return true;' })
  await screenshot({ name: 'composer-after.png' })
  await fill({ label: 'Reply to Hydra', value: 'First line\nSecond line\nThird line' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight > window.composerRest', label: 'draft grows with its content' })
  await fill({ label: 'Reply to Hydra', value: Array.from({ length: 30 }, (_, i) => `Line ${i}`).join('\n') })
  await eventually({ condition: 'document.querySelector(".hydra-chat textarea").clientHeight === 128', label: 'automatic draft growth stops at 128 px' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").scrollHeight > 128 && getComputedStyle(document.querySelector(".hydra-chat textarea")).overflowY === "auto"', label: 'long draft scrolls internally' })
  await screenshot({ name: 'composer-long.png' })
  await fill({ label: 'Reply to Hydra', value: '' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer").clientHeight === window.composerRest', label: 'empty draft shrinks again' })
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
  await check({ condition: '[...document.querySelectorAll(".hydra-chat [role=combobox]")].map(x => x.getAttribute("aria-label")).join(",") === "Harness,Model,Effort,Permissions,Fast" && !document.querySelector(".hydra-chat [role=dialog]")', label: 'Hydra settings are directly in the composer' })
  await click({ selector: '.hydra-chat [aria-label=Harness]' })
  await click({ selector: '[role=listbox][aria-label=Harness] [role=option]:nth-child(2)' })
  await eventually({ condition: 'document.querySelector(".hydra-chat [aria-label=Harness]").textContent.includes("Codex") && !document.querySelector(".hydra-chat [aria-label=Harness]").disabled', label: 'harness selection saves for the next message' })
  assert.equal(effectiveDispatch({ hydraId: 'default', state: state() }).dispatch.rules.hydra, undefined)
  assert.equal(state().config?.hydra.agent?.harness, 'codex')
  await screenshot({ name: 'composer-picker.png' })
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
