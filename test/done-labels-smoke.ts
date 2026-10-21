import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-done-labels-smoke-',
))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
commands.hydra([
  'create',
  'default',
  '--done-after-hours',
  '0',
])
commands.task([
  'create',
  '--key',
  'completed',
  '--title',
  'Ship cursor pagination',
  '--column',
  'done',
])
commands.task([
  'create',
  '--key',
  'waiting',
  '--title',
  'Keep the next task',
  '--column',
  'parked',
])
const state = () => loadHydra({ hydraId: 'default' }).state
const id = state().keys.completed!
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
})
const {
  browser,
  evaluate,
  eventually,
  check,
  click,
  text,
  focus,
  fill,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-done-labels',
})

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
      '1440',
      '900',
    ],
  })
  await browser({
    args: [
      'wait',
      'Ship cursor pagination',
    ],
  })
  await screenshot({ name: 'project-label-before.png' })
  commands.task([
    'rename',
    id,
    '--project',
    'payments-api',
  ])
  await eventually({
    condition: 'document.querySelector(".project-label")?.textContent === "payments-api"',
    label: 'project label appears on the card',
  })
  await screenshot({ name: 'project-label-after.png' })
  await text({ label: 'Settings' })
  await eventually({
    condition: '!!document.querySelector("[aria-label=\\"Hide Done cards after hours\\"]")',
    label: 'Hydra retention setting appears',
  })
  await screenshot({ name: 'done-retention-settings.png' })
  const beforeSetting = state().seq
  await focus({ selector: '[aria-label="Hide Done cards after hours"]' })
  await fill({
    label: 'Hide Done cards after hours',
    value: '0.0005',
  })
  await evaluate({ code: 'document.querySelector("[aria-label=\\"Hide Done cards after hours\\"]").blur(); return true;' })
  await eventually({
    condition: `Number(document.querySelector('.app').dataset.seq) > ${beforeSetting}`,
    label: 'retention setting event reaches the browser',
  })
  assert.equal(
    state().config?.doneAfterHours,
    0.0005,
  )
  await click({ selector: '[data-hydra-current]' })
  await eventually({
    condition: `!document.querySelector('[data-task="${id}"]')`,
    label: 'Done card expires without another command',
  })
  assert.equal(
    state().config?.doneAfterHours,
    0.0005,
  )
  assert.equal(
    state().cards[id]?.hidden,
    true,
  )
  await check({
    condition: 'document.body.textContent.includes("Keep the next task")',
    label: 'non-Done task stays visible',
  })
  process.stdout.write('Done expiry, Settings and labels browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
