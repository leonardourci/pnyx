import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { effectiveDispatch } from '../src/dispatch/config.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-owner-approval-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.CODEX_HOME = join(
  home,
  'codex',
)
process.env.PNYX_SEMANTIC = 'off'
fakeDispatch({
  root: home,
  hydraId: 'default',
})
commands.hydra([
  'create',
  'default',
])

for (let index = 0; index < 30; index++) {
  commands.hydra([
    'send',
    '--text',
    `Earlier conversation ${index}. ${'A saved discussion. '.repeat(20)}`,
    '--actor',
    'hydra',
  ])
}

const sdk = hydraSdk()
const server = await startServer({
  hydraId: 'default',
  query: sdk.query,
})
const b = smokeBrowser({
  home,
  session: 'pnyx-owner-approval',
})
const state = () => loadHydra({ hydraId: 'default' }).state
const current = () => effectiveDispatch({
  hydraId: 'default',
  state: state(),
}).dispatch.default
const before = current()

try {
  await b.browser({
    args: [
      'open',
      server.url,
    ],
  })
  await b.browser({
    args: [
      'resize',
      '1440',
      '1000',
    ],
  })
  await b.eventually({
    condition: '!!document.querySelector(".hydra-chat")',
    label: 'Hydra chat loaded',
  })
  await b.screenshot({ name: 'owner-question-before.png' })
  dispatchCommands.rule([
    'propose',
    'set',
    'default',
    '--harness',
    'codex',
    '--model',
    'gpt-6.1-sol',
    '--actor',
    'hydra',
  ])
  assert.deepEqual(
    current(),
    before,
  )
  await b.eventually({
    condition: '!!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'proposal arrives in chat',
  })
  await b.check({
    condition: '(() => { const region = document.querySelector(\'.hydra-messages\'); const button = region.querySelector(\'[aria-label="Pending owner question"] button.primary\'); const parent = region.getBoundingClientRect(); const rect = button.getBoundingClientRect(); return region.scrollHeight > region.clientHeight && rect.top >= parent.top && rect.bottom <= parent.bottom; })()',
    label: 'Confirm is visible below an overflowing conversation',
  })
  await b.screenshot({ name: 'owner-question-pending.png' })
  await b.click({ selector: '[aria-label="Pending owner question"] button.primary' })
  await b.eventually({
    condition: '!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'Confirm resolves proposal',
  })
  assert.equal(
    current()[0]?.harness,
    'codex',
  )
  dispatchCommands.rule([
    'propose',
    'set',
    'default',
    '--harness',
    'claude',
    '--actor',
    'hydra',
  ])
  await b.eventually({
    condition: '!!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'second proposal arrives',
  })
  await b.click({ selector: '[aria-label="Pending owner question"] button.quiet' })
  await b.eventually({
    condition: '!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'Dismiss resolves proposal',
  })
  assert.equal(
    current()[0]?.harness,
    'codex',
  )
  ownerOnly({
    commands,
    env: { PNYX_ACTOR: 'hydra' },
  }).hydra([
    'set',
    '--command',
    'printf approved',
  ])
  assert.equal(
    state().config?.command,
    undefined,
  )
  await b.eventually({
    condition: '!!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'owner-only command becomes a question',
  })
  await b.screenshot({ name: 'owner-command-pending.png' })
  await b.click({ selector: '[aria-label="Pending owner question"] button.primary' })
  await b.eventually({
    condition: '!document.querySelector(\'[aria-label="Pending owner question"]\')',
    label: 'owner command confirmed',
  })

  for (let index = 0; index < 100 && state().config?.command !== 'printf approved'; index++) {
    await new Promise(resolve => setTimeout(
      resolve,
      50,
    ))
  }

  assert.equal(
    state().config?.command,
    'printf approved',
  )
  await b.screenshot({ name: 'owner-question-confirmed.png' })
  process.stdout.write(`Owner question smoke passed on private port ${server.port}.\n`)
} finally {
  await b.close()
  await server.close()
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
