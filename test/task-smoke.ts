import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import type { QueryFn } from '../src/server/host.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-task-smoke-'))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    for (const [key, title] of [['task', 'Attachment test task'], ['a', 'Alpha work'], ['b', 'Beta work']]) {
      const transcript = join(home, `${key}.jsonl`)
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: `${title} message from its session` } }) + '\n')
      const decision = decidePush({ state: writer.state, key: key!, input: { title, ...(key !== 'task' ? { agent: { provider: 'claude-code', sessionId: key, transcriptPath: transcript, cwd: home }, terminal: { tty: '/dev/ttys123' }, activity: key === 'a' ? 'ended' : 'working' } : {}) }, meta: { at: '2026-10-14T12:00:00Z', actor: 'fixture' } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    }
  },
})
commands.hydra(['create', 'default', '--identity', 'fixture'])
const received: string[] = []
const query = (({ prompt, options }) => {
  if (options?.resume) {
    assert.equal(options.resume, 'a')
  } else {
    assert.ok(options?.sessionId)
  }

  async function* turn() {
    for await (const message of prompt as AsyncIterable<{ message: { content: string } }>) {
      received.push(message.message.content)
      yield { type: 'result' }
    }
  }

  return Object.assign(turn(), { close: () => {} })
}) as QueryFn
const server = await startServer({ hydraId: 'default', query })
const { browser, evaluate, eventually, check, click, text, fill, screenshot, close } = smokeBrowser({ home, session: 'pnyx-tasks' })
const hydraId = () => loadHydra({ hydraId: 'default' }).state
const menu = () => click({ selector: '[aria-label="Task menu"]' })

const attach = async ({ title }: { title: string }) => {
  await menu(); await text({ label: hydraId().cards.c1?.agent ? 'Change agent' : 'Attach agent' })
  await click({ selector: '[aria-label="Attach agent session"]' })
  await evaluate({ code: `const option = [...document.querySelectorAll('[role=option]')].find(o => o.textContent.includes(${JSON.stringify(title)})); option.click(); return true;` })
  await browser({ args: ['wait', `${title} message from its session`] })
}

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] }); await browser({ args: ['wait', 'Attachment test task'] })
  await click({ selector: '.card-open' })
  await check({ condition: '!!document.querySelector(".card > .detail .task-brief") && !document.querySelector(".start-agent")', label: 'an unattached task opens to its editable brief' })
  await fill({ label: 'Task brief', value: 'Read the component and explain the edge cases.' }); await text({ label: 'Save brief' })
  await eventually({ condition: 'document.querySelector(".task-brief button").disabled', label: 'brief saved' })
  assert.equal(hydraId().cards.c1?.brief, 'Read the component and explain the edge cases.')
  await menu(); await text({ label: 'Start' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Create a worker for task")', label: 'Start posts the task request visibly in Hydra chat' })
  assert.equal(hydraId().hydraMessages?.at(-1)?.task, 'c1')
  assert.equal(hydraId().hydraMessages?.at(-1)?.action, 'worker')
  assert.equal(hydraId().cards.c1?.agent, undefined)
  assert.equal(received.length, 0)
  await check({ condition: '!document.querySelector(".start-agent")', label: 'Start leaves worker choices to Hydra' })
  await screenshot({ name: 'start-request-after.png' })
  await attach({ title: 'Alpha work' }); assert.equal(hydraId().cards.c1?.agent?.sessionId, 'a')
  await eventually({ condition: '[...document.querySelectorAll(".detail button")].some(b => b.textContent === "Continue in Pnyx")', label: 'ended outside session offers continuation' })
  await screenshot({ name: 'continue-before.png' })
  await text({ label: 'Continue in Pnyx' })
  await eventually({ condition: 'document.querySelector(".detail .agent-chip")?.textContent === "Claude Code · Pnyx"', label: 'continuation changes the host on the same card' })
  assert.equal(hydraId().cards.c1?.agent?.sessionId, 'a')
  assert.equal(received.length, 0)
  await fill({ label: 'Reply to Attachment test task', value: 'Continue the same conversation' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: 'document.querySelector(".detail .composer textarea").value === ""', label: 'hosted reply clears the composer' })
  assert.deepEqual(received, ['Continue the same conversation'])
  await screenshot({ name: 'continue-after.png' })
  await menu(); await text({ label: 'Change agent' }); await text({ label: 'Detach agent' })
  await eventually({ condition: '!!document.querySelector(".task-brief")', label: 'detaching restores the brief' })
  await attach({ title: 'Beta work' }); assert.equal(hydraId().cards.c1?.agent?.sessionId, 'b')
  await check({ condition: '!document.querySelector(".detail .thread").textContent.includes("Alpha work message")', label: 'changing agents discards the previous conversation' })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const card = writer.state.cards.c1!
      const decision = decidePush({ state: writer.state, key: card.key, input: { agent: { ...card.agent!, cwd: join(home, 'missing') }, activity: 'ended', source: { adapter: 'hooks', instanceId: 'claude', objectId: 'b', observedAt: new Date().toISOString() } }, meta: { at: new Date().toISOString(), actor: 'fixture' } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({ condition: '[...document.querySelectorAll(".detail button")].some(b => b.textContent === "Ask Hydra to start fresh")', label: 'a missing folder offers a fresh start' })
  await text({ label: 'Ask Hydra to start fresh' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Create a worker for task")', label: 'fresh start requests a worker in Hydra chat' })
  await check({ condition: '!document.querySelector(".start-agent")', label: 'start never opens a one-off form' })
  assert.equal(hydraId().cards.c1?.agent?.sessionId, 'b')
  assert.equal(received.length, 1)
  assert.equal(hydraId().hydraMessages?.at(-1)?.action, 'worker')
  await screenshot({ name: 'start-after.png' })

  await menu(); await text({ label: 'Add subtask' }); await browser({ args: ['wait', 'New subtask'] })
  await fill({ label: 'Rename task New subtask', value: 'Browser subtask' }); await text({ label: 'Save title' }); await browser({ args: ['wait', 'Browser subtask'] })
  assert.equal(Object.values(hydraId().cards).filter(c => c.parentId).length, 1)
  await click({ selector: '[aria-label="Close detail"]' })
  await click({ selector: '[aria-label="New task in Parked"]' }); await browser({ args: ['wait', 'New task'] })
  await fill({ label: 'Rename task New task', value: 'Browser task' }); await text({ label: 'Save title' }); await browser({ args: ['wait', 'Browser task'] })
  await check({ condition: 'document.querySelector("[data-column=parked] .column-cards .card:first-child").textContent.includes("Browser task")', label: 'column plus creates the task at the top' })
  await text({ label: '+ Add column' }); await browser({ args: ['wait', 'New column'] })
  await fill({ label: 'Rename New column column', value: 'Research' }); await text({ label: 'Save title' }); await browser({ args: ['wait', 'Research'] })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Edit description' })
  await fill({ label: 'Research description', value: 'Keep tasks here while gathering evidence.' }); await text({ label: 'Save description' })
  await eventually({ condition: 'document.querySelector("[aria-label=Research] h2").title === "Keep tasks here while gathering evidence."', label: 'column descriptions are saved and appear on hover' })
  await evaluate({ code: 'const columns = [...document.querySelectorAll(".column")]; const dt = new DataTransfer(); columns.at(-1).querySelector(".column-header").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); columns[0].dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt })); return true;' })
  await eventually({ condition: 'document.querySelector(".column").getAttribute("aria-label") === "Research"', label: 'columns move by dragging the header' })
  const task = Object.values(hydraId().cards).find(c => c.title === 'Browser task')!
  await evaluate({ code: `const task = document.querySelector('[data-task="${task.id}"]'); const dt = new DataTransfer(); task.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt})); document.querySelector('[aria-label=Research]').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:dt})); return true;` })
  await eventually({ condition: 'document.querySelector("[aria-label=Research] .card")?.textContent.includes("Browser task")', label: 'owner drag moves a task' })
  await click({ selector: '[aria-label="Research column menu"]' }); await text({ label: 'Delete column' })
  await check({ condition: '!!document.querySelector(".delete-confirm") && !document.querySelector("[role=dialog]")', label: 'delete confirms in place with Yes and No' })
  await text({ label: 'No' }); await text({ label: 'Delete column' }); await text({ label: 'Yes' })
  await eventually({ condition: '!document.querySelector("[aria-label=Research]")', label: 'confirmed column deletion removes the column' })
  assert.equal(hydraId().config?.columns.length, 5)
  await fill({ label: 'Reply to Hydra', value: 'Keep this Hydra focused.' }); await click({ selector: '.hydra-chat .composer-send' })
  await eventually({ condition: 'document.querySelector(".hydra-chat .composer textarea").value === ""', label: 'Hydra send clears the delivered draft' })
  assert.equal(hydraId().hydraMessages?.at(-1)?.text, 'Keep this Hydra focused.')
  await screenshot({ name: 'task-attachment.png' })
  const firstmate = join(home, 'firstmate-fixture')
  cpSync(join(import.meta.dirname, 'fixtures', 'firstmate-home'), firstmate, { recursive: true })
  commands.hydra(['set', '--firstmate', firstmate])
  commands.task(['create', '--title', 'Firstmate request', '--key', 'firstmate-request'])
  await eventually({ condition: 'document.body.textContent.includes("Firstmate request")', label: 'Firstmate task arrives' })
  const requested = hydraId().keys['firstmate-request']!
  await click({ selector: `[data-task="${requested}"] .card-open` })
  await menu(); await text({ label: 'Start' })
  await eventually({ condition: 'document.body.textContent.includes("Sent to Firstmate")', label: 'Firstmate Start preserves inbox delivery' })
  const notes = JSON.parse(readFileSync(join(firstmate, 'inbox.json'), 'utf8')) as { body: string }[]
  assert.match(notes.at(-1)?.body ?? '', /asks for a worker on task/)
  assert.equal(hydraId().hydraMessages?.at(-1)?.task, requested)
  assert.equal(hydraId().cards[requested]?.agent, undefined)

  process.stdout.write('Task, brief, attachment and column browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
