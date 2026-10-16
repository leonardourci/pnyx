import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decidePush, decideSession } from '../src/core/decide.ts'
import { commands } from '../src/cli/commands.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { fakeCodex } from './codex-fixture.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-codex-smoke-')))
process.env.PNYX_HOME = join(root, 'pnyx')
process.env.CODEX_HOME = join(root, 'codex')
process.env.PNYX_SEMANTIC = 'off'
await commands.hydra(['create', 'default'])
await workerCommands.kind(['set', 'default', '--harness', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--mode', 'on-request'])
await commands.task(['create', '--title', 'Hosted Codex smoke', '--key', 'smoke', '--folder', root])
await commands.task(['brief', 'smoke', '--brief', 'Explain the provider boundary.'])
await commands.task(['create', '--title', 'Outside Codex smoke', '--key', 'outside', '--folder', root])
const fixture = fakeCodex({ root })
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const meta = { actor: 'fixture', at: new Date().toISOString() }
    const pushed = decidePush({ state: writer.state, newCardId: `c${writer.state.seq + 1}`, key: 'codex:outside-thread', input: { agent: { provider: 'codex', sessionId: 'outside-thread', cwd: root, transcriptPath: fixture.transcript }, terminal: { tty: '/dev/ttys123' }, activity: 'ended', source: { adapter: 'hooks', instanceId: 'codex', objectId: 'outside-thread', observedAt: meta.at } }, meta })
    assert.ok('event' in pushed); writer.append({ event: pushed.event })
    const attached = decideSession({ state: writer.state, ref: 'codex:outside-thread', task: writer.state.keys.outside!, meta })
    assert.ok('event' in attached); writer.append({ event: attached.event })
  },
})
const server = await startServer({ hydraId: 'default', spawnCodex: fixture.spawnCodex })
const { browser, evaluate, text, click, fill, check, eventually, screenshot, close } = smokeBrowser({ home: root, session: 'pnyx-codex' })

const task = () => {
  const state = loadHydra({ hydraId: 'default' }).state

  return state.cards[state.keys.smoke!]!
}

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '1000'] })
  await browser({ args: ['wait', 'Hosted Codex smoke'] })
  await click({ selector: `[data-task="${task().id}"] .card-open` })
  await click({ selector: '[aria-label="Task menu"]' })
  await text({ label: 'Start' })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Create a worker for task")', label: 'Codex task Start requests Hydra’s choice' })
  assert.equal(fixture.children.length, 0)
  assert.equal(task().agent, undefined)
  await check({ condition: '!document.querySelector(".start-agent")', label: 'Start does not choose a provider or launch a worker' })
  await screenshot({ name: 'codex-start.png' })
  await commands.task(['start', 'smoke', '--actor', 'hydra', '--reason', 'Use the project’s default agent'])
  await eventually({ condition: 'document.querySelector(".agent-chip")?.textContent === "Codex · Pnyx"', label: 'Codex attaches as a hosted agent' })
  await browser({ args: ['wait', 'Codex: Explain the provider boundary.'] })
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(task().agent?.provider, 'codex')
  await fill({ label: 'Reply to Hosted Codex smoke', value: 'Continue from the browser' })
  await click({ selector: '.detail [aria-label="Send reply"]' })
  await browser({ args: ['wait', 'Codex: Continue from the browser'] })
  await click({ selector: '.detail [aria-label="Agent settings"]' })
  await click({ selector: '.detail .composer-settings [aria-label=Effort]' })
  await evaluate({ code: 'const option = [...document.querySelectorAll(\'[role=option]\')].find(o => o.textContent.trim() === \'low\'); option.click(); return true;' })
  await check({ condition: 'document.querySelector(".detail [aria-label=Effort]")?.textContent.includes("low")', label: 'Codex effort is staged in the picker' })
  assert.notEqual(task().settings?.effort, 'low')
  await text({ label: 'Apply settings' })
  await eventually({ condition: 'document.querySelector(".detail .agent-picker > button")?.textContent.includes("low")', label: 'Codex effort picker applies directly' })

  for (let i = 0; i < 100 && task().settings?.effort !== 'low'; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  assert.equal(task().settings?.effort, 'low')
  await screenshot({ name: 'codex-hosted.png' })
  await click({ selector: '[aria-label="Close detail"]' })
  await click({ selector: '[aria-label="Open conversation for Outside Codex smoke"]' })
  await eventually({ condition: '[...document.querySelectorAll(".detail button")].some(b => b.textContent === "Continue in Pnyx")', label: 'an ended outside Codex session offers continuation' })
  await screenshot({ name: 'codex-continue-before.png' })
  await text({ label: 'Continue in Pnyx' })
  await eventually({ condition: 'document.querySelector(".detail .agent-chip")?.textContent === "Codex · Pnyx"', label: 'Codex continuation changes the host' })
  assert.equal(fixture.children.length, 1)
  await fill({ label: 'Reply to Outside Codex smoke', value: 'Resume the outside thread' })
  await click({ selector: '.detail [aria-label="Send reply"]' })
  await browser({ args: ['wait', 'Codex: Resume the outside thread'] })
  assert.equal(fixture.messages().find(m => m.method === 'thread/resume')?.params?.threadId, 'outside-thread')
  await screenshot({ name: 'codex-continue-after.png' })
  process.stdout.write('Hosted Codex and outside continuation browser smoke passed.\n')
} finally {
  await server.close()
  await close()
  rmSync(root, { recursive: true, force: true })
}
