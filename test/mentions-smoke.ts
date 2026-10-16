import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { taskMentions } from '../src/mentions/mentions.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-mentions-smoke-'))
process.env.PNYX_HOME = home
seedWebFixture({ home })
commands.task(['create', '--key', 'mention-reference', '--title', 'Migration plan', '--brief', 'Preserve violet rollback checks', '--project', 'API'])
commands.task(['create', '--key', 'mention-receiver', '--title', 'Review task'])
commands.task(['status', 'mention-reference', 'working', '--note', 'Rollback verified'])
const state = () => loadHydra({ hydraId: 'default' }).state
const reference = state().keys['mention-reference']!
const receiver = state().keys['mention-receiver']!
const server = await startServer({ hydraId: 'default', homes: [] })
const { browser, evaluate, check, eventually, click, text, fill, press, focus, screenshot, close } = smokeBrowser({ home, session: 'pnyx-mentions' })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '900'] })
  await browser({ args: ['wait', 'Needs you'] })
  await focus({ selector: '.hydra-chat textarea' })
  await screenshot({ name: 'mentions-before.png' })
  await evaluate({ code: 'window.mentionComposerHeight = document.querySelector(".hydra-chat .composer").getBoundingClientRect().height; return true;' })
  await fill({ label: 'Reply to Hydra', value: '@violet' })
  await eventually({ condition: 'document.querySelector(".mention-menu [role=option]")?.textContent.includes("Migration plan")', label: 'initial prompt search opens a task result' })
  await check({ condition: 'document.querySelector(".mention-menu").textContent.includes("API") && document.querySelector(".mention-menu").textContent.includes("violet rollback") && document.querySelector(".mention-menu").matches(":popover-open")', label: 'floating row shows title, project and matching prompt excerpt' })
  await check({ condition: 'document.querySelector(".hydra-chat .composer").getBoundingClientRect().height === window.mentionComposerHeight', label: 'mention results never push composer content' })
  await screenshot({ name: 'mentions-picker.png' })
  await focus({ selector: '.hydra-chat textarea' })
  await press({ key: 'Escape' })
  await check({ condition: '!document.querySelector(".mention-menu") && document.querySelector(".hydra-chat textarea").value === "@violet"', label: 'Escape dismisses without clearing the draft' })
  await fill({ label: 'Reply to Hydra', value: '@no-such-task' })
  await check({ condition: 'document.querySelector(".mention-menu").textContent.includes("No matching tasks in this Hydra.")', label: 'empty search is explicit' })
  await press({ key: 'Enter' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").value === "@no-such-task"', label: 'Enter with no matches never sends or changes the draft' })
  await fill({ label: 'Reply to Hydra', value: '@' })
  await press({ key: 'ArrowDown' })
  await check({ condition: 'document.querySelectorAll(".mention-menu [role=option]")[1].getAttribute("aria-selected") === "true"', label: 'Down arrow selects the next task' })
  await press({ key: 'ArrowUp' })
  await check({ condition: 'document.querySelectorAll(".mention-menu [role=option]")[0].getAttribute("aria-selected") === "true"', label: 'Up arrow selects the previous task' })
  await fill({ label: 'Reply to Hydra', value: 'Compare @Migration' })
  await press({ key: 'Enter' })
  await check({ condition: 'document.querySelector(".hydra-chat textarea").value.startsWith("Compare [@Migration plan](pnyx-task:") && !!document.querySelector(".hydra-chat .draft-mentions .task-mention") && !document.querySelector(".mention-menu")', label: 'Enter inserts a stable readable reference and a draft chip' })
  await click({ selector: '.hydra-chat .composer-send' })
  await eventually({ condition: '!!document.querySelector(".hydra-chat .messages .task-mention") && document.querySelector(".hydra-chat textarea").value === ""', label: 'sent references render as clickable chips' })
  const message = state().hydraMessages?.find(message => message.text.startsWith('Compare '))
  assert.deepEqual(taskMentions({ text: message?.text ?? '' }), [{ id: reference, title: 'Migration plan' }])
  assert.match(message?.context ?? '', /Latest update: Rollback verified/)
  commands.task(['rename', reference, '--title', 'Renamed migration'])
  await click({ selector: '.hydra-chat .messages .task-mention' })
  await eventually({ condition: '!!document.querySelector(\'.detail[aria-label="Details for Renamed migration"]\')', label: 'chip opens the same task after rename' })
  await click({ selector: '[aria-label="Close detail"]' })
  await click({ selector: `[data-card="${receiver}"]` })
  await eventually({ condition: '!!document.querySelector(".detail textarea")', label: 'card stream composer opens' })
  await click({ selector: '.detail [aria-label="Add to message"]' })
  await text({ label: 'Mention a task' })
  await check({ condition: '!!document.querySelector(".mention-menu") && document.activeElement.matches(".detail textarea")', label: 'card plus opens the same mention picker' })
  await fill({ label: 'Reply to Review task', value: '@violet' })
  await screenshot({ name: 'mentions-card.png' })
  await click({ selector: '.mention-menu [role=option]' })
  await check({ condition: 'document.querySelector(".detail textarea").value.includes("[@Renamed migration](pnyx-task:")', label: 'mouse selection captures the current title' })
  await click({ selector: '.detail .composer-send' })
  await eventually({ condition: '!!document.querySelector(".detail .messages .task-mention")', label: 'card history renders the mention chip' })
  await screenshot({ name: 'mentions-sent.png' })
  assert.equal(state().cards[receiver]?.agent, undefined)
  assert.equal(state().cards[reference]?.agent, undefined)
  assert.equal(state().cards[reference]?.replies?.length ?? 0, 0)
  await browser({ args: ['resize', '700', '500'] })
  await fill({ label: 'Reply to Hydra', value: '@violet' })
  await check({ condition: '(() => { const bounds = document.querySelector(".mention-menu").getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth; })()', label: 'mention list stays in the short viewport' })
  await screenshot({ name: 'mentions-short.png' })
  const consoleOutput = await browser({ args: ['console'] })
  assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught|ResizeObserver loop/)
  process.stdout.write('Task mentions browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
