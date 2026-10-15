import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { startServer } from '../src/server/server.ts'
import { loadBoard } from '../src/store/board-store.ts'
import { smokeBrowser } from './browser.ts'
import { fakeCodex } from './codex-fixture.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-codex-smoke-')))
process.env.PNYX_HOME = join(root, 'pnyx')
process.env.CODEX_HOME = join(root, 'codex')
process.env.PNYX_SEMANTIC = 'off'
await commands.board(['create', 'default'])
await workerCommands.kind(['set', 'default', '--harness', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--mode', 'on-request'])
await commands.task(['create', '--title', 'Hosted Codex smoke', '--key', 'smoke', '--folder', root])
await commands.task(['brief', 'smoke', '--brief', 'Explain the provider boundary.'])
const fixture = fakeCodex({ root })
const server = await startServer({ board: 'default', spawnCodex: fixture.spawnCodex })
const { browser, evaluate, text, click, fill, check, eventually, screenshot, close } = smokeBrowser({ home: root, session: 'pnyx-codex' })

const task = () => {
  const state = loadBoard({ board: 'default' }).state

  return state.cards[state.keys.smoke!]!
}

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '1000'] })
  await browser({ args: ['wait', 'Hosted Codex smoke'] })
  await click({ selector: `[data-task="${task().id}"] .card-open` })
  await click({ selector: '[aria-label="Task menu"]' })
  await text({ label: 'Start agent' })
  await check({ condition: 'document.querySelector("[aria-label=Agent]").textContent.includes("Codex")', label: 'Start agent uses the default kind’s provider' })
  await screenshot({ name: 'codex-start.png' })
  await click({ selector: '.start-agent button[type=submit]' })
  await eventually({ condition: 'document.querySelector(".agent-chip")?.textContent === "Codex · Pnyx"', label: 'Codex attaches as a hosted agent' })
  await browser({ args: ['wait', 'Codex: Explain the provider boundary.'] })
  assert.equal(task().agent?.host, 'pnyx')
  assert.equal(task().agent?.provider, 'codex')
  await fill({ label: 'Reply to Hosted Codex smoke', value: 'Continue from the browser' })
  await click({ selector: '.detail [aria-label="Send reply"]' })
  await browser({ args: ['wait', 'Codex: Continue from the browser'] })
  await click({ selector: '.composer-settings [aria-label=Effort]' })
  await evaluate({ code: 'const option = [...document.querySelectorAll(\'[role=option]\')].find(o => o.textContent.trim() === \'low\'); option.click(); return true;' })
  await eventually({ condition: 'document.querySelector(".composer-settings [aria-label=Effort]")?.textContent.includes("low")', label: 'Codex effort picker applies directly' })

  for (let i = 0; i < 100 && task().settings?.effort !== 'low'; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  assert.equal(task().settings?.effort, 'low')
  await screenshot({ name: 'codex-hosted.png' })
  process.stdout.write('Hosted Codex browser smoke passed.\n')
} finally {
  await server.close()
  await close()
  rmSync(root, { recursive: true, force: true })
}
