import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydraConfig } from '../src/core/hydra.ts'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-reminders-smoke-',
))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
commands.hydra([
  'create',
  'default',
])
commands.hydra([
  'resize',
  '--width',
  '280',
])
const state = () => loadHydra({ hydraId: 'default' }).state
const columns = hydraConfig({ state: state() }).columns
const parked = columns.find(column => column.role === 'parked')!.id
const needsYou = columns.find(column => column.role === 'needs_you')!.id

for (const column of columns) {
  commands.column([
    'resize',
    column.id,
    '--width',
    '240',
  ])
}

commands.task([
  'create',
  '--key',
  'review',
  '--title',
  'Review cursor pagination',
  '--column',
  parked,
])
const id = state().keys.review!
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
})
const {
  browser,
  eventually,
  check,
  click,
  text,
  fill,
  screenshot,
  close,
  evaluate,
} = smokeBrowser({
  home,
  session: 'pnyx-reminders',
})
const remind = () => click({ selector: `[data-task="${id}"] [aria-label="Remind"]` })

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'resize',
      '1600',
      '900',
    ],
  })
  await browser({
    args: [
      'wait',
      'Review cursor pagination',
    ],
  })
  await screenshot({ name: 'reminder-before.png' })
  await remind()
  await check({
    condition: '!!document.querySelector(".reminder-editor") && !document.querySelector("[role=dialog]")',
    label: 'Remind opens an inline editor',
  })
  await click({ selector: '.reminder-editor label' })
  await check({
    condition: '!document.querySelector(".detail") && document.querySelector(".card").draggable === false',
    label: 'editing a reminder keeps the card closed and prevents dragging',
  })
  await fill({
    label: 'Reminder time',
    value: 'tomorrow 9:00',
  })
  await evaluate({ code: 'const button = document.querySelector(".reminder-editor button[type=submit]"); button.focus(); return true;' })
  await check({
    condition: 'document.querySelector(".reminder-editor button[type=submit]").getBoundingClientRect().bottom <= document.querySelector(".card-rest").getBoundingClientRect().bottom + 1',
    label: 'closed-card reminder controls remain inside their content area',
  })
  await fill({
    label: 'Reminder time',
    value: 'yesterday',
  }); await text({ label: 'Set reminder' })
  await eventually({
    condition: '!!document.querySelector(".reminder-editor [role=alert]")',
    label: 'invalid time stays in the editor with an error',
  })
  await fill({
    label: 'Reminder time',
    value: 'tomorrow 9:00',
  }); await text({ label: 'Set reminder' })
  await eventually({
    condition: '!!document.querySelector(".reminder-label") && !document.querySelector(".reminder-editor")',
    label: 'saved reminder appears on its card',
  })
  await check({
    condition: '!!document.querySelector(".card-state") && document.querySelector(".card-state").textContent.includes("Not started")',
    label: 'waiting reminder appears alongside the card state',
  })
  await eventually({
    condition: 'document.querySelector(`[aria-controls="panel-reminders"]`)?.textContent === "Reminders 1"',
    label: 'setting a reminder updates the panel count',
  })
  await text({ label: 'Reminders 1' })
  await check({
    condition: 'document.querySelector(`#panel-reminders`).textContent.includes("Review cursor pagination")',
    label: 'panel lists the waiting reminder in place',
  })
  assert.ok(state().cards[id]?.reminder?.at)
  assert.equal(
    (await commands.task(['reminders'])).count,
    1,
  )
  await screenshot({ name: 'reminder-after.png' })
  await remind(); await text({ label: 'Clear reminder' })
  await eventually({
    condition: '!document.querySelector(".reminder-label") && !document.querySelector(".reminder-editor")',
    label: 'clear removes the waiting reminder',
  })
  assert.equal(
    state().cards[id]?.reminder,
    undefined,
  )
  await click({ selector: '.card-open' })
  await remind()
  await check({
    condition: '!!document.querySelector(".card.selected .reminder-editor")',
    label: 'expanded task offers the same reminder editor',
  })
  await fill({
    label: 'Reminder time',
    value: new Date(Date.now() + 2000).toISOString(),
  }); await text({ label: 'Set reminder' })
  await eventually({
    condition: `!!document.querySelector('[data-column="${needsYou}"] [data-task="${id}"]')`,
    label: 'due reminder moves its card to Needs you',
  })
  await eventually({
    condition: 'document.querySelector(".hydra-messages").textContent.includes("Reminder: Review cursor pagination")',
    label: 'due reminder appears in Hydra chat',
  })
  await check({
    condition: '!!document.querySelector(".activity-asks")',
    label: 'due reminder displays the Needs you card state',
  })
  assert.equal(
    state().cards[id]?.status?.state,
    'needs_you',
  )
  assert.equal(
    (await commands.task(['reminders'])).count,
    0,
  )
  await eventually({
    condition: 'document.querySelector(`[aria-controls="panel-reminders"]`)?.textContent === "Reminders 0" && document.querySelector(`#panel-reminders`).textContent === "No waiting reminders."',
    label: 'due reminders leave the panel count and list',
  })
  await check({
    condition: '!document.querySelector(".reminder-label")',
    label: 'fired reminder leaves the waiting list',
  })
  await screenshot({ name: 'reminder-due.png' })
  await check({
    condition: 'document.documentElement.scrollWidth <= innerWidth',
    label: 'reminder controls fit without horizontal overflow',
  })
  process.stdout.write('Reminder editor, validation, clearing, due move and Hydra chat smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
