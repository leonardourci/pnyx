import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupSkills } from '../src/integrations/skills/install.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-skills-smoke-',
))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.CODEX_HOME = join(
  home,
  'codex',
)
process.env.PNYX_HOME = join(
  home,
  'data',
)
process.env.PNYX_SEMANTIC = 'off'
process.env.PNYX_PASEO_URL = 'ws://127.0.0.1:1/ws'
const server = await startServer({ hydraId: 'default' })
const {
  browser,
  text,
  check,
  eventually,
  evaluate,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-skills',
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
      '1000',
    ],
  })
  await browser({
    args: [
      'wait',
      'Settings',
    ],
  })
  await text({ label: 'Settings' })
  const row = '[...document.querySelectorAll(".integrations dl > div")].find(el => el.querySelector("dt").textContent === "skills")'
  await eventually({
    condition: `/missing: \\d+ global skill links/.test(${row}?.textContent || '')`,
    label: 'missing global skills shown in Settings',
  })
  await evaluate({ code: 'document.querySelector(".integrations").scrollIntoView({ block: "center" }); return true;' })
  await screenshot({ name: 'skills-missing.png' })
  setupSkills()
  await text({ label: 'Check again' })
  await eventually({
    condition: `${row}?.querySelector(".ok")?.textContent === "ready"`,
    label: 'global skills become ready after setup',
  })
  await check({
    condition: `${row}.querySelector("code").textContent === "pnyx-axi setup skills"`,
    label: 'Settings offers the global setup command',
  })
  await screenshot({ name: 'skills-ready.png' })
  setupSkills({ remove: true })
  await text({ label: 'Check again' })
  await eventually({
    condition: `/missing: \\d+ global skill links/.test(${row}?.textContent || '')`,
    label: 'removing global skills updates Settings readiness',
  })
  process.stdout.write('Passed: global skill readiness in Settings before setup, after setup and after removal\n')
} finally {
  await close()
  await server.close()
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
