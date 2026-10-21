import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-notification-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.PNYX_SEMANTIC = 'off'
commands.hydra([
  'create',
  'default',
])
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
})
const b = smokeBrowser({
  home,
  session: 'pnyx-notification',
})

try {
  await b.browser({
    args: [
      'open',
      server.url,
    ],
  })
  await b.eventually({
    condition: 'document.querySelector(".app")?.dataset.connected === "true"',
    label: 'connected',
  })
  await b.fill({
    label: 'Reply to Hydra',
    value: 'Check the task',
  })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({
    condition: '!!document.querySelector(".notice")',
    label: 'send shows a toast',
  })
  await b.evaluate({ code: 'await new Promise(resolve => setTimeout(resolve, 5500)); return true;' })
  await b.check({
    condition: '!document.querySelector(".notice")',
    label: 'toast closes on its own',
  })
  assert.doesNotMatch(
    await b.browser({ args: ['console'] }),
    /TypeError|ReferenceError|Uncaught/,
  )
} finally {
  await b.close(); await server.close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
