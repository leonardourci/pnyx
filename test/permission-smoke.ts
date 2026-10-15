import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { commands } from '../src/cli/commands.ts'
import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import type { QueryFn } from '../src/server/host.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-permission-smoke-'))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.PNYX_SEMANTIC = 'off'
const results: PermissionResult[] = []
let release: (() => void) | undefined
const gate = new Promise<void>(resolve => {
  release = resolve
})
const query = (({ prompt, options }: {
  prompt: AsyncIterable<unknown>
  options: Options
}) => {
  async function* run() {
    for await (const message of prompt) {
      assert.ok(message)
      await gate
      const result = await options.canUseTool!('Bash', { command: 'touch allowed.txt' }, {
        signal: new AbortController().signal, toolUseID: 'smoke-tool', requestId: 'smoke-request',
      })
      assert.ok(result)
      results.push(result)
      yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
    }
  }

  return Object.assign(run(), { close() {} })
}) as unknown as QueryFn

await commands.hydra(['create', 'default', '--hydra', 'default'])
await commands.task(['create', '--title', 'Permission example', '--key', 'permission', '--folder', home, '--column', 'workers_on_it'])
let server = await startServer({ hydraId: 'default', query })
const state = () => loadHydra({ hydraId: 'default' }).state
const task = () => state().cards[state().keys.permission!]!
const { browser, eventually, check, click, text, screenshot, close } = smokeBrowser({ home, session: 'pnyx-permissions' })
await startTask({ hydraId: 'default', task: 'permission', meta: { at: new Date().toISOString(), actor: 'fixture' } })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1400', '1000'] })
  await browser({ args: ['wait', 'Permission example'] })
  await click({ selector: '.card-open' })
  await screenshot({ name: 'permission-before.png' })
  release?.()
  await eventually({ condition: '!!document.querySelector(".ask button")', label: 'permission buttons appear' })
  await check({ condition: 'document.querySelector("[data-column=workers_on_it]").textContent.includes("Needs you · permission") && document.querySelector(".permission-input").textContent.includes("touch allowed.txt")', label: 'request shows tool input and Needs you in the original column' })
  await screenshot({ name: 'permission-pending.png' })
  await text({ label: 'Allow' })
  await eventually({ condition: 'document.querySelector(".ask .receipt")?.textContent === "Allowed"', label: 'Allow resolves the request' })
  assert.deepEqual(results, [{ behavior: 'allow' }])
  assert.equal(task().column, 'workers_on_it')
  await sendReply({ hydraId: 'default', request: { card: task().id, text: 'Ask again', homes: [], actor: 'fixture' } })
  await eventually({ condition: '!!document.querySelector(".ask button")', label: 'second request appears' })
  await text({ label: 'Deny' })
  await eventually({ condition: '[...document.querySelectorAll(".ask .receipt")].some(e => e.textContent === "Denied")', label: 'Deny resolves the request' })
  assert.equal(results[1]?.behavior, 'deny')
  await sendReply({ hydraId: 'default', request: { card: task().id, text: 'Ask before restart', homes: [], actor: 'fixture' } })
  await eventually({ condition: '!!document.querySelector(".ask button")', label: 'third request appears' })
  await server.close()
  server = await startServer({ hydraId: 'default', query })
  await browser({ args: ['open', server.url] })
  await browser({ args: ['wait', 'Permission example'] })
  await click({ selector: '.card-open' })
  await eventually({ condition: 'document.querySelectorAll(".ask .receipt").length === 3', label: 'restart retains request history' })
  await check({ condition: '!document.querySelector(".ask button") && [...document.querySelectorAll(".ask .receipt")].some(e => e.textContent.includes("Expired"))', label: 'expired request has no answer controls' })
  await screenshot({ name: 'permission-expired.png' })
} finally {
  await close()
  await server.close()
  rmSync(home, { recursive: true, force: true })
}
