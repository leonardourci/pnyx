import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-card-states-'))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
commands.hydra(['create', 'default'])
const now = Date.now()
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const columns = writer.state.config!.columns

    for (const [key, title, role, activity, age] of [
      ['queued', 'Write migration plan', 'queued', undefined, 0],
      ['working', 'Check pagination', 'in_progress', 'working', 0],
      ['finished', 'Review the patch', 'in_progress', 'finished', 0],
      ['stopped', 'Investigate retry failure', 'in_progress', 'ended', 2],
      ['asks', 'Pick retry policy', 'needs_you', 'finished', 0],
      ['done', 'Ship cursor pagination', 'done', undefined, 2],
      ['soon', 'Ship retry metrics', 'done', undefined, 21],
    ] as const) {
      const meta = { actor: 'fixture', at: new Date(now - age * 3600000).toISOString() }
      const created = hydraEvent({ state: writer.state, meta, cardId: `task-${randomUUID()}`, change: { type: 'task.created', data: { key, title, project: 'payments-api', column: columns.find(c => c.role === role)!.id } } })
      assert.ok('event' in created); writer.append({ event: created.event })

      if (activity) {
        const pushed = decidePush({ state: writer.state, key, input: { agent: { provider: 'claude-code', sessionId: key, cwd: home }, activity, source: { adapter: 'hooks', objectId: key } }, meta })
        assert.ok('event' in pushed); writer.append({ event: pushed.event })
      }
    }
  },
})
commands.task(['status', 'asks', 'needs_you', '--note', 'Which retry policy?'])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = hydraEvent({ state: writer.state, meta: { actor: 'fixture', at: new Date(now).toISOString() }, cardId: writer.state.keys.queued!, change: { type: 'task.copy', data: { before: null, after: { path: home, project: home, via: 'worktree', state: 'flagged', reason: 'it has uncommitted changes' } } } })
    assert.ok('event' in decision); writer.append({ event: decision.event })
  },
})
const state = () => loadHydra({ hydraId: 'default' }).state
const stopped = state().keys.stopped!, soon = state().keys.soon!
const initialLaunch = state().cards[stopped]?.launch
const server = await startServer({ hydraId: 'default' })
const { browser, evaluate, check, click, text, eventually, screenshot, close } = smokeBrowser({ home, session: 'pnyx-card-states' })

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1800', '1000'] })
  await eventually({ condition: 'document.querySelectorAll(".card-state").length === 7', label: 'all card states rendered' })
  await check({ condition: 'document.body.textContent.includes("not started") && document.body.textContent.includes("finished its turn") && document.body.textContent.includes("stopped · 2h ago") && document.body.textContent.includes("asks") && document.body.textContent.includes("done · 2h ago") && document.body.textContent.includes("hidden in 3h")', label: 'states and relative Done labels' })
  await evaluate({ code: `const card = document.querySelector('[data-task="${stopped}"]'); card.querySelector('.card-open').focus(); return true;` })
  await check({ condition: 'document.body.textContent.includes("copy not cleaned")', label: 'flagged copy state shown' })
  await screenshot({ name: 'card-states-after.png' })
  await click({ selector: `[data-task="${stopped}"] .card-resume` })
  await eventually({ condition: 'document.querySelector(".hydra-chat").textContent.includes("Resume the stopped worker")', label: 'Resume request appears in Hydra chat' })
  assert.equal(state().hydraMessages?.at(-1)?.task, stopped)
  assert.equal(state().hydraMessages?.at(-1)?.actor, 'web')
  assert.deepEqual(state().cards[stopped]?.launch, initialLaunch)
  await evaluate({ code: 'window.copiedId = null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.copiedId = value; } } }); return true;' })
  await click({ selector: `[data-task="${soon}"] .card-menu button` })
  await text({ label: 'Copy ID' })
  await check({ condition: `window.copiedId === ${JSON.stringify(soon)}`, label: 'card Copy ID copies its actual ID' })
  await click({ selector: '[aria-label="Done column menu"]' }); await text({ label: 'Copy ID' })
  const doneColumn = state().config!.columns.find(c => c.role === 'done')!.id
  await check({ condition: `window.copiedId === ${JSON.stringify(doneColumn)}`, label: 'column Copy ID copies its random ID' })
  await click({ selector: `[data-task="${soon}"] .card-menu button` }); await text({ label: 'Hide after…' })
  await check({ condition: 'document.querySelector(".hide-after").closest("[popover]").matches(":popover-open") && document.querySelector(".hide-after").getBoundingClientRect().bottom <= innerHeight', label: 'hide choices float above the column and stay in view' })
  await screenshot({ name: 'card-hide-after.png' })
  await text({ label: 'Keep visible' })
  await eventually({ condition: `document.querySelector('[data-task="${soon}"]').textContent.includes('done · 21h ago')`, label: 'keep visible removes countdown' })
  assert.equal(state().cards[soon]?.doneAfterHours, 0)
  await click({ selector: `[data-task="${soon}"] .card-menu button` }); await text({ label: 'Hide after…' }); await text({ label: '3 days' })
  await eventually({ condition: '!document.querySelector(".menu-items")', label: 'choice closes menu' })
  await eventually({ condition: `Number(document.querySelector('.app').dataset.seq) === ${state().seq}`, label: 'per-card change reaches browser' })
  assert.equal(state().cards[soon]?.doneAfterHours, 72)
  await click({ selector: `[data-task="${soon}"] .card-menu button` }); await text({ label: 'Hide after…' }); await text({ label: 'Use Hydra setting' })
  await eventually({ condition: `document.querySelector('[data-task="${soon}"]').textContent.includes('hidden in 3h')`, label: 'Hydra default restores countdown' })
  process.stdout.write('Card states, Resume routing, Copy ID and hide override browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
