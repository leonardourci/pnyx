import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-dispatch-smoke-'))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.CODEX_HOME = join(home, 'codex')
process.env.PNYX_HOME = home
const probe = createServer()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const address = probe.address()
await promisify(probe.close.bind(probe))()

if (!address || typeof address === 'string') {
  throw new Error('No private Paseo port allocated')
}

process.env.PNYX_PASEO_URL = `ws://127.0.0.1:${address.port}/ws`
process.env.PNYX_SEMANTIC = 'off'
fakeDispatch({ root: home, hydraId: 'default' })
commands.hydra(['create', 'default'])
dispatchCommands.rule(['set', 'hydra', '--harness', 'claude', '--model', 'opus'])
dispatchCommands.rule(['set', 'build', '--when', 'Implementation and debugging', '--candidates', '[{"harness":"claude","model":"opus","effort":"high"},{"harness":"codex","model":"gpt-6.1-sol"}]'])
dispatchCommands.rule(['accounts', '--provider', 'codex', '--order', 'codex:test', '--project', home])
commands.task(['create', '--key', 'work', '--title', 'Heads dispatch smoke', '--folder', home])
const card = loadHydra({ hydraId: 'default' }).state.keys.work!
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const event = hydraEvent({ state: writer.state, cardId: card, meta: { actor: 'fixture', at: new Date().toISOString() }, change: { type: 'task.launched', data: { via: 'pnyx', at: new Date().toISOString(), dispatch: 'build: opus on claude:test; Claude 25%, Codex 82%; selected by spendPriority' } } })
    assert.ok('event' in event)
    writer.append({ event: event.event })
  },
})
const server = await startServer({ hydraId: 'default' })
const { browser, text, click, eventually, check, screenshot, evaluate, close } = smokeBrowser({ home, session: 'pnyx-heads-dispatch' })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['wait', 'Heads dispatch smoke'] })
  await text({ label: 'Settings' })
  await eventually({ condition: 'document.querySelector(\'[aria-label="Rule build"]\')?.textContent.includes("Implementation and debugging")', label: 'Settings loads effective heads dispatch rules' })
  await check({ condition: 'document.querySelector(\'[aria-label="Agents"]\').textContent.includes("claude:test") && document.querySelector(\'[aria-label="Agents"]\').textContent.includes("codex:test") && document.querySelector(\'[aria-label="Agents"]\').textContent.includes("Main account: claude:test")', label: 'Settings shows the main and worker accounts' })
  await check({ condition: `document.querySelector('[aria-label="Agents"]').textContent.includes("Worker account order") && document.querySelector('[aria-label="Agents"]').textContent.includes(${JSON.stringify(home)})`, label: 'Settings shows project account overrides' })
  await eventually({ condition: 'document.querySelector(\'[aria-label="Hydra default model"]\')?.value === "opus"', label: 'Settings loads the saved Hydra model into the input' })
  await evaluate({ code: 'const input = document.querySelector(\'[aria-label="Hydra default model"]\'); input.focus(); input.blur(); return true;' })
  await check({ condition: 'document.querySelector(\'[aria-label="Hydra default model"]\').value === "opus"', label: 'untouched blur preserves the loaded model' })
  const saved = dispatchCommands.rule(['list']) as unknown as { dispatch: { rules: { hydra: { candidates: { model: string }[] } } } }
  assert.equal(saved.dispatch.rules.hydra.candidates[0]?.model, 'opus')
  await screenshot({ name: 'heads-dispatch-settings.png' })
  await click({ selector: '[data-hydra-current]' })
  await click({ selector: `[data-card="${card}"]` })
  await eventually({ condition: 'document.querySelector(\'[aria-label="Heads dispatch choice"]\')?.textContent.includes("build: opus on claude:test")', label: 'task details show the recorded dispatch reason' })
  await screenshot({ name: 'heads-dispatch-choice.png' })
  process.stdout.write('Heads dispatch smoke passed.\n')
} finally {
  await close()
  await server.close()
  rmSync(home, { recursive: true, force: true })
}
