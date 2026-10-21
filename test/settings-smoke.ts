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
  'pnyx-settings-smoke-',
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
  session: 'pnyx-settings',
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
  await b.text({ label: 'Settings' })
  await b.eventually({
    condition: '!!document.querySelector(".settings .integrations dl")',
    label: 'Settings loads',
  })
  await b.browser({
    args: [
      'open',
      server.url,
    ],
  })
  await b.eventually({
    condition: '!!document.querySelector(".settings .integrations dl") && !!document.querySelector("[aria-label=Oracle] [role=switch]") && !!document.querySelector("[aria-label^=Rule]")',
    label: 'direct Settings reload waits for the connection and completes every read',
  })
  await b.check({
    condition: '!document.querySelector(".settings [role=alert]") && !document.querySelector(".notice")',
    label: 'Settings reload has no premature-read error',
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
