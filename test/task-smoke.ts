import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-task-smoke-')))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
commands.hydra(['create', 'default'])
commands.task(['create', '--key', 'review', '--title', 'Review the migration plan', '--brief', 'Check the rollback path before rollout.', '--column', 'in_progress'])
commands.task(['create', '--key', 'long', '--title', 'A very long title '.repeat(15), '--column', 'in_progress'])
const state = () => loadHydra({ hydraId: 'default' }).state
const task = () => state().cards[state().keys.review!]!
const transcript = join(home, 'worker.jsonl')
writeFileSync(transcript, Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: `2026-10-16T01:${String(i).padStart(2, '0')}:00Z`, message: { content: i % 2 ? 'The migration passes locally. I am checking the rollback path and the canary gate.\n\n' + 'A factual update from the worker. '.repeat(4) : 'Please inspect the migration and preserve its existing data.' } })).join('\n') + '\n')
commands.task(['status', 'review', 'working', '--note', 'The migration passes locally; checking the rollback path.', '--actor', 'worker'])
const native = join(home, 'firstmate')
cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), native, { recursive: true })
const server = await startServer({
  hydraId: 'default',
  homes: [native],
  query: () => {
    throw new Error('A UI task request must never start an agent')
  },
})
const { browser, evaluate, check, click, text, fill, screenshot, eventually, close } = smokeBrowser({ home, session: 'pnyx-tasks' })
const menu = () => click({ selector: '[aria-label="Task menu"]' })

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'Review the migration plan'] })
  await check({ condition: '[...document.querySelectorAll(".card")].every(c => c.getBoundingClientRect().height === 176)', label: 'closed cards stay 176 px despite long titles' })
  await check({ condition: 'document.querySelector(".last-message").textContent.includes("migration passes locally")', label: 'a factual worker update appears at rest' })
  await screenshot({ name: 'cards-closed-after.png' })
  await click({ selector: '.card-open' })
  await check({ condition: 'document.activeElement.matches(".detail .composer textarea") && document.querySelector(".card.selected").getBoundingClientRect().height === 480', label: 'opening a card fixes it at 480 px and focuses its composer' })
  await check({ condition: 'document.querySelector(".detail .message.mine").textContent.includes("Check the rollback path") && !!document.querySelector(".detail .message:not(.mine)")', label: 'initial prompt and factual updates share one stream' })
  await menu()
  await check({ condition: '!document.querySelector(".detail").textContent.match(/Attach agent|Change agent|Detach agent|Continue in Pnyx/)', label: 'manual assignment controls are absent' })
  await text({ label: 'Start' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Create a worker for task")', label: 'Start requests Hydra without launching an agent' })
  assert.equal(task().agent, undefined)
  await fill({ label: 'Reply to Review the migration plan', value: 'Please preserve the rollback notes for assignment.' })
  await click({ selector: '.detail .composer-send' })
  await eventually({ condition: 'document.querySelector(".detail .composer textarea").value === "" && document.querySelector(".detail .messages").textContent.includes("Hydra: Queued")', label: 'unassigned messages are preserved with a Hydra queue receipt' })
  assert.equal(state().hydraMessages?.at(-1)?.task, task().id)
  assert.equal(state().hydraMessages?.at(-1)?.text, 'Please preserve the rollback notes for assignment.')
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({ state: writer.state, key: 'review', input: { agent: { provider: 'claude-code', sessionId: 'fixture', transcriptPath: transcript, cwd: home }, activity: 'finished', source: { adapter: 'firstmate', instanceId: native, objectId: 'work' } }, meta: { at: new Date().toISOString(), actor: 'hydra' } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({ condition: 'document.querySelectorAll(".detail .message").length > 10', label: 'the assigned worker history enters the same stream' })
  await check({ condition: 'document.querySelector(".card.selected").getBoundingClientRect().height === 480 && document.querySelector(".detail .thread").scrollHeight > document.querySelector(".detail .thread").clientHeight', label: 'long conversations scroll inside a fixed card' })
  await check({ condition: '!document.querySelector(".card.selected").textContent.includes("done ·") && !document.querySelector(".running") && document.querySelector(".card-state").textContent.includes("finished its turn")', label: 'a finished turn is neither Running nor task Done' })
  await evaluate({ code: 'window.composerBottom = document.querySelector(".detail .composer").getBoundingClientRect().bottom; document.querySelector(".detail .thread").scrollTop = 0; return true;' })
  await check({ condition: 'document.querySelector(".detail .composer").getBoundingClientRect().bottom === window.composerBottom', label: 'scrolling the stream keeps the composer anchored' })
  await menu(); await text({ label: 'Resume' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Resume the worker on task")', label: 'Resume is a task-scoped Hydra request' })
  const attached = task().agent
  await menu(); await text({ label: 'Reassign' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Reassign task")', label: 'Reassign asks Hydra to choose its next agent' })
  assert.deepEqual(task().agent, attached)
  await fill({ label: 'Reply to Review the migration plan', value: 'Confirm both routes' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: 'document.querySelector(".detail .composer textarea").value === "" && document.querySelector(".detail .messages").textContent.includes("Agent: Delivered")', label: 'worker delivery and Hydra queue each have a receipt' })
  assert.match(readFileSync(join(native, 'sent.log'), 'utf8'), /Confirm both routes/)
  writeFileSync(join(native, 'send-exit'), '2')
  await fill({ label: 'Reply to Review the migration plan', value: 'Retain this failed route' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: '!!document.querySelector(".detail .reply-failure") && document.querySelector(".detail .messages").textContent.includes("Agent: Delivery failed")', label: 'a worker route failure is shown alongside the Hydra receipt' })
  await check({ condition: 'document.querySelector(".detail .composer textarea").value === "Retain this failed route"', label: 'partial failure preserves the draft' })
  rmSync(join(native, 'send-exit'))
  await click({ selector: '.detail .composer-send' })
  await eventually({ condition: 'document.querySelector(".detail .composer textarea").value === ""', label: 'retry repairs only the failed route' })
  assert.equal(state().hydraMessages?.filter(m => m.text === 'Retain this failed route').length, 1)
  await click({ selector: '.detail .jump' })
  await screenshot({ name: 'cards-open-after.png' })
  await browser({ args: ['resize', '1440', '400'] })
  await check({ condition: 'document.querySelector(".card.selected").getBoundingClientRect().height <= document.querySelector(".column-cards").clientHeight && document.querySelector(".card.selected").getBoundingClientRect().height < 480', label: 'short panes cap the fixed card height' })
  await check({ condition: 'document.querySelector(".detail .composer").getBoundingClientRect().bottom <= document.querySelector(".card.selected").getBoundingClientRect().bottom', label: 'short panes retain an accessible composer' })
  await screenshot({ name: 'cards-short-pane.png' })
  await browser({ args: ['resize', '1440', '900'] })
  await menu(); await text({ label: 'Add subtask' })
  await check({ condition: '!!document.querySelector(".task-create") && document.activeElement.getAttribute("aria-label") === "Task title"', label: 'plus creates a task inline and focuses its title' })
  const before = Object.keys(state().cards).length
  await fill({ label: 'Task title', value: 'Inspect the canary' }); await fill({ label: 'Initial prompt', value: 'Check the canary gate before rollout.' })
  assert.equal(Object.keys(state().cards).length, before)
  await text({ label: 'Save task' })
  await eventually({ condition: 'document.querySelector(".card.selected")?.textContent.includes("Inspect the canary") && document.activeElement.matches(".detail .composer textarea")', label: 'saving opens the task and focuses its composer without starting it' })
  const created = Object.values(state().cards).find(c => c.title === 'Inspect the canary')!
  assert.equal(created.brief, 'Check the canary gate before rollout.')
  assert.equal(created.parentId, task().id)
  assert.equal(created.agent, undefined)
  await click({ selector: '[aria-label="Close detail"]' })
  await click({ selector: '[aria-label="New task in Parked"]' }); await text({ label: 'Cancel' })
  assert.equal(Object.keys(state().cards).length, before + 1)
  await text({ label: '+ Add column' }); await browser({ args: ['wait', 'New column'] })
  await fill({ label: 'Rename New column column', value: 'Research' }); await text({ label: 'Save title' })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Edit description' })
  await fill({ label: 'Research description', value: 'Gather evidence before rollout.' }); await text({ label: 'Save description' })
  await eventually({ condition: 'document.querySelector("[aria-label=Research] h2").title === "Gather evidence before rollout."', label: 'column descriptions remain editable' })
  await evaluate({ code: 'const columns = [...document.querySelectorAll(".column")]; const dt = new DataTransfer(); columns.at(-1).querySelector(".column-header").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); columns[0].dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt })); return true;' })
  await eventually({ condition: 'document.querySelector(".column").getAttribute("aria-label") === "Research"', label: 'columns still move by dragging the header' })
  await evaluate({ code: `const task = document.querySelector('[data-task="${created.id}"]'); const dt = new DataTransfer(); task.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt})); document.querySelector('[aria-label=Research]').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:dt})); return true;` })
  await eventually({ condition: 'document.querySelector("[aria-label=Research] .card")?.textContent.includes("Inspect the canary")', label: 'fixed cards still move by dragging' })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Delete column' })
  await check({ condition: '!!document.querySelector(".delete-confirm") && !document.querySelector("[role=dialog]")', label: 'column deletion still confirms inline' })
  await text({ label: 'No' }); await text({ label: 'Delete column' }); await text({ label: 'Yes' })
  await eventually({ condition: '!document.querySelector("[aria-label=Research]")', label: 'confirmed deletion removes the column' })
  assert.equal(state().config?.columns.length, 5)
  commands.hydra(['set', '--firstmate', native])
  await click({ selector: `[data-task="${created.id}"] .card-open` })
  await menu(); await text({ label: 'Start' })
  await eventually({ condition: 'document.body.textContent.includes("Sent to Firstmate")', label: 'Firstmate Start uses its inbox delivery' })
  const notes = JSON.parse(readFileSync(join(native, 'inbox.json'), 'utf8')) as { body: string }[]
  assert.match(notes.at(-1)?.body ?? '', /asks for a worker on task/)
  assert.equal(state().hydraMessages?.at(-1)?.task, created.id)
  assert.equal(created.agent, undefined)
  process.stdout.write('Fixed cards, task streams, Hydra requests and route receipts browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
