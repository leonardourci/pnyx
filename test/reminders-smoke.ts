import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-reminders-smoke-'))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
commands.hydra(['create', 'default'])
commands.hydra(['resize', '--width', '280'])

for (const id of ['needs_you', 'workers_on_it', 'done', 'parked']) {
  commands.column(['resize', id, '--width', '240'])
}

commands.task(['create', '--key', 'review', '--title', 'Review cursor pagination', '--column', 'parked'])
const state = () => loadHydra({ hydraId: 'default' }).state
const id = state().keys.review!
const server = await startServer({ hydraId: 'default' })
const { browser, eventually, check, click, text, fill, screenshot, close } = smokeBrowser({ home, session: 'pnyx-reminders' })
const menu = () => click({ selector: '[aria-label="Task menu for Review cursor pagination"]' })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '900'] })
  await browser({ args: ['wait', 'Review cursor pagination'] })
  await screenshot({ name: 'reminder-before.png' })
  await menu(); await text({ label: 'Remind me…' })
  await check({ condition: '!!document.querySelector(".reminder-editor") && !document.querySelector("[role=dialog]")', label: 'Remind me opens an inline editor' })
  await fill({ label: 'Reminder time', value: 'yesterday' }); await text({ label: 'Set reminder' })
  await eventually({ condition: '!!document.querySelector(".reminder-editor [role=alert]")', label: 'invalid time stays in the editor with an error' })
  await fill({ label: 'Reminder time', value: 'tomorrow 9:00' }); await text({ label: 'Set reminder' })
  await eventually({ condition: '!!document.querySelector(".reminder-label") && !document.querySelector(".reminder-editor")', label: 'saved reminder appears on its card' })
  assert.ok(state().cards[id]?.reminder?.at)
  assert.equal((await commands.task(['reminders'])).count, 1)
  await screenshot({ name: 'reminder-after.png' })
  await menu(); await text({ label: 'Remind me…' }); await text({ label: 'Clear reminder' })
  await eventually({ condition: '!document.querySelector(".reminder-label") && !document.querySelector(".reminder-editor")', label: 'clear removes the waiting reminder' })
  assert.equal(state().cards[id]?.reminder, undefined)
  await click({ selector: '.card-open' })
  await click({ selector: '[aria-label="Task menu"]' }); await text({ label: 'Remind me…' })
  await check({ condition: '!!document.querySelector(".detail .reminder-editor")', label: 'task detail offers the same reminder editor' })
  await fill({ label: 'Reminder time', value: new Date(Date.now() + 2000).toISOString() }); await text({ label: 'Set reminder' })
  await eventually({ condition: `!!document.querySelector('[data-column=needs_you] [data-task="${id}"]')`, label: 'due reminder moves its card to Needs you' })
  await eventually({ condition: 'document.querySelector(".hydra-messages").textContent.includes("Reminder: Review cursor pagination")', label: 'due reminder appears in Hydra chat' })
  assert.equal(state().cards[id]?.status?.state, 'needs_you')
  assert.equal((await commands.task(['reminders'])).count, 0)
  await check({ condition: '!document.querySelector(".reminder-label")', label: 'fired reminder leaves the waiting list' })
  await screenshot({ name: 'reminder-due.png' })
  await check({ condition: 'document.documentElement.scrollWidth <= innerWidth', label: 'reminder controls fit without horizontal overflow' })
  process.stdout.write('Reminder editor, validation, clearing, due move and Hydra chat smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
