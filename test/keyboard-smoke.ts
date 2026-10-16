import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-keyboard-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const { browser, evaluate, eventually, check, fill, press, focus, screenshot, close } = smokeBrowser({ home, session: 'pnyx-keyboard' })
const card = `[data-card="${fixture.state.keys.layout}"]`
const state = () => loadHydra({ hydraId: 'default' }).state

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'Needs you'] })
  const platform = await browser({ args: ['eval', '() => /Mac|iPhone|iPad/.test(navigator.platform)'] })
  const mod = platform.includes('true') ? 'Meta' : 'Control'
  await focus({ selector: card }); await press({ key: `${mod}+b` })
  await check({ condition: 'document.querySelector(".left-panel").hidden && document.querySelector(".hydra-chat").getBoundingClientRect().height > 800', label: 'Mod+B hides the left panel completely' })
  await press({ key: `${mod}+k` })
  await check({ condition: '!document.querySelector(".left-panel").hidden && document.activeElement.matches("[data-oracle-slot] input") && !document.querySelector("[role=dialog]")', label: 'Mod+K reveals and focuses the one search field' })
  await focus({ selector: card }); await press({ key: 'ArrowDown' })
  await check({ condition: `document.activeElement.dataset.card === ${JSON.stringify(fixture.state.keys.coverage)}`, label: 'arrows navigate cards' })
  await press({ key: 'k' }); await check({ condition: `document.activeElement.matches(${JSON.stringify(card)})`, label: 'k navigates back' })
  await press({ key: `${mod}+ArrowRight` })
  await eventually({ condition: `document.querySelector(${JSON.stringify(card)}).closest('[data-column]').dataset.column === 'parked'`, label: 'Mod+Right moves the highlighted task' })
  assert.equal(state().cards[fixture.state.keys.layout!]?.column, 'parked')
  await press({ key: `${mod}+ArrowLeft` })
  await eventually({ condition: `document.querySelector(${JSON.stringify(card)}).closest('[data-column]').dataset.column === 'needs_you'`, label: 'Mod+Left moves it back' })
  await focus({ selector: '[data-column-heading=in_progress]' }); await press({ key: `${mod}+ArrowRight` })
  await eventually({ condition: 'document.querySelectorAll(".column")[2].dataset.column === "in_progress"', label: 'Mod+arrows move the highlighted column' })
  await focus({ selector: card }); await press({ key: 'Enter' }); await browser({ args: ['wait', 'The first pass is ready to review.'] })
  await check({ condition: 'document.activeElement.matches(".detail .composer textarea")', label: 'opening a card focuses its composer' })
  const snapshot = await browser({ args: ['snapshot'] })
  const block = snapshot.match(/uid=(\S+) group "Message block 1"/)
  assert.ok(block, snapshot)
  await browser({ args: ['click', `@${block[1]}`] })
  await check({ condition: '!!document.querySelector(".detail .message-block[data-active=true]") && [...document.querySelectorAll(".detail .message-block")].every(block => getComputedStyle(block).boxShadow === "none") && !document.querySelector(".detail .block-comment-action")', label: 'clicking a message adds no bracket or comment cue' })
  await focus({ selector: card }); await press({ key: 'r' })
  await check({ condition: '!!document.querySelector(".detail") && document.activeElement.matches(".detail .composer textarea")', label: 'r focuses an already-open card without closing it' })
  await fill({ label: 'Reply to Shape the first working Hydra', value: 'Literal hjkl / ? m' }); await press({ key: 'Enter' }); await press({ key: 'j' })
  await check({ condition: 'document.querySelector(".detail .composer textarea").value === "Literal hjkl / ? m\\nj" && !document.querySelector("[role=dialog]")', label: 'typing stays literal in the composer' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.matches(".detail [data-caret-host]") && getSelection().isCollapsed', label: 'Escape enters the latest reply with a keyboard caret' })
  await press({ key: 'ArrowRight' })
  await check({ condition: '[...document.querySelectorAll(".detail .message-block")].every(block => getComputedStyle(block).boxShadow === "none") && !document.querySelector(".detail .block-comment-action")', label: 'moving the message caret adds no bracket or comment cue' })
  await press({ key: 'Shift+End' }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement.matches(".detail .inline-comment textarea")', label: 'Enter comments on the keyboard selection' })
  await fill({ label: 'Comment on selected text', value: 'Make this clearer.' }); await press({ key: 'Escape' }); await press({ key: 'Enter' })
  await fill({ label: 'Reply to Shape the first working Hydra', value: 'Apply that comment.' }); await press({ key: `${mod}+Enter` })
  await eventually({ condition: 'document.querySelector(".detail .composer textarea").value === ""', label: 'Mod+Enter sends the task reply' })
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /Make this clearer/)
  const sent = state().hydraMessages?.length ?? 0
  await focus({ selector: '.hydra-chat .composer textarea' }); await fill({ label: 'Reply to Hydra', value: 'Hydra keyboard reply' }); await press({ key: `${mod}+Enter` })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer textarea").value === ""', label: 'Hydra keyboard send uses its own composer' })
  assert.equal(state().hydraMessages?.length, sent + 1)
  await evaluate({ code: 'document.querySelector(".detail .composer textarea").focus(); return true;' })
  await press({ key: `${mod}+b` }); await check({ condition: 'document.querySelector(".left-panel").hidden', label: 'Mod+B works while typing a reply' })
  await press({ key: `${mod}+k` }); await check({ condition: 'document.activeElement.matches("[data-oracle-slot] input")', label: 'Mod+K works while typing' })
  await screenshot({ name: 'keyboard.png' })
  process.stdout.write('Keyboard browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
