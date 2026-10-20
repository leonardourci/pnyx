import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD } from '../src/core/hydra.ts'
import { configPath, writeConfig } from '../src/dispatch/config.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-chat-smoke-'))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.PNYX_SEMANTIC = 'off'
commands.hydra(['create', 'default'])
writeConfig({ path: configPath({ hydraId: 'default', shared: true }), value: { default: [{ harness: 'claude', model: 'sonnet', effort: 'high' }] } })
const sdk = hydraSdk(); sdk.control.hold = true
let server = await startServer({ hydraId: 'default', query: sdk.query })
const b = smokeBrowser({ home, session: 'pnyx-hydra-chat' })
const state = () => loadHydra({ hydraId: 'hydra-2' }).state

try {
  await b.browser({ args: ['open', server.url] })
  await b.browser({ args: ['resize', '1440', '1000'] })
  await b.eventually({ condition: '!!document.querySelector(\'[aria-label="Create Hydra"]\')', label: 'loaded' })
  await b.click({ selector: '[aria-label="Create Hydra"]' })
  await b.eventually({ condition: 'location.pathname.includes("hydra-2") && document.activeElement.matches(".hydra-chat textarea")', label: 'one click opens and focuses an empty Hydra' })
  await b.check({ condition: '!document.querySelector(\'[aria-label="New Hydra name"]\') && !document.querySelector(\'dialog\') && !!document.querySelector(\'.hydra-project-setup\')', label: 'projects remain available without a creation form' })
  await b.eventually({ condition: 'document.querySelector(".hydra-agent-pickers [aria-label=Model]")?.textContent.includes("sonnet")', label: 'composer uses shared heads-dispatch defaults' })
  await b.screenshot({ name: 'after-empty.png' })
  await b.fill({ label: 'Reply to Hydra', value: 'Hello Hydra' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: 'document.querySelector(".hydra-messages").textContent.includes("Hydra is working")', label: 'hosted turn has a working indicator' })
  assert.equal(sdk.calls[0]?.options.model, 'sonnet')
  await b.screenshot({ name: 'after-replying.png' })
  await b.click({ selector: '.hydra-agent-pickers [aria-label=Model]' })
  await b.eventually({ condition: '[...document.querySelectorAll(".hydra-agent-pickers [role=listbox][aria-label=Model] [role=option]")].some(option => option.textContent.trim() === "opus")', label: 'SDK model catalog loads in the picker' })
  await b.click({ selector: '.hydra-agent-pickers [role=listbox][aria-label=Model] [role=option]:nth-child(1)' })
  await b.eventually({ condition: 'document.querySelector(".hydra-agent-pickers [aria-label=Model]").textContent.includes("opus") && !document.querySelector(".hydra-agent-pickers [aria-label=Model]").disabled', label: 'model choice saves during a turn' })
  assert.equal(sdk.calls[0]?.options.model, 'sonnet')
  sdk.release()
  await b.eventually({ condition: 'document.querySelector(".hydra-messages").textContent.includes("Hydra: Hello Hydra") && !document.querySelector(".hydra-messages").textContent.includes("Hydra is working")', label: 'answer streams into Hydra chat and clears the indicator' })
  await b.fill({ label: 'Reply to Hydra', value: 'Use the next model' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: 'document.querySelector(".hydra-messages").textContent.includes("Hydra: Use the next model")', label: 'the next message resumes and answers' })
  assert.equal(sdk.calls[1]?.options.model, 'opus')
  assert.equal(sdk.calls[1]?.options.resume, sdk.calls[0]?.options.sessionId)
  sdk.control.stream = true; sdk.control.hold = true
  await b.fill({ label: 'Reply to Hydra', value: 'Comment while streaming' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: '!!document.querySelector(".hydra-chat [data-streaming] .message-block")', label: 'reply streams before its turn finishes' })
  await b.evaluate({ code: 'document.querySelector(".hydra-chat .hydra-messages").focus(); return true;' })
  await b.press({ key: 'c' })
  await b.fill({ label: 'Comment on selected text', value: 'Keep this streamed passage.' }); await b.press({ key: 'Escape' })
  sdk.release()
  await b.eventually({ condition: '!document.querySelector(".hydra-chat [data-streaming]") && !document.querySelector(".hydra-chat .message-block[data-message-id^=\'live:\']") && document.querySelector(".hydra-chat .inline-comment")?.textContent.includes("Keep this streamed passage.")', label: 'a comment on a streamed reply stays with it once the transcript saves it' })
  sdk.control.stream = false
  await b.fill({ label: 'Reply to Hydra', value: 'Apply the comment' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: '!document.querySelector(".hydra-chat .inline-comment")', label: 'the comment goes with the next message' })
  assert.match(sdk.calls[1]?.messages.at(-1) ?? '', /## Comments on your reply from [\s\S]*Keep this streamed passage\.[\s\S]*## Message\n\nApply the comment/)
  const session = state().config?.hydra.session
  const port = server.port
  await server.close(); server = await startServer({ hydraId: 'hydra-2', port, query: sdk.query })
  await b.browser({ args: ['open', server.url] })
  await b.eventually({ condition: 'document.querySelector(".hydra-messages")?.textContent.includes("Hydra: Use the next model")', label: 'transcript survives a server restart' })
  sdk.control.fail = true
  await b.fill({ label: 'Reply to Hydra', value: 'Show an error' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: 'document.querySelector(".hydra-messages [role=alert]")?.textContent.includes("Harness login is missing")', label: 'harness failure appears inline' })
  assert.equal(state().config?.hydra.session, session)
  assert.equal(state().cards[HYDRA_CARD]?.sessionActivity, 'interrupted')
  await b.screenshot({ name: 'after-error.png' })
  sdk.control.fail = false; sdk.control.ask = true
  await b.fill({ label: 'Reply to Hydra', value: 'List the folder' })
  await b.click({ selector: '.hydra-chat .composer-send' })
  await b.eventually({ condition: 'document.querySelector(".hydra-chat .ask .permission-input")?.textContent.includes("ls")', label: 'Hydra’s permission prompt shows in its chat' })
  await b.screenshot({ name: 'hydra-permission.png' })
  await b.text({ label: 'Allow' })
  await b.eventually({ condition: 'document.querySelector(".hydra-messages").textContent.includes("Hydra: List the folder") && !document.querySelector(".hydra-chat .ask")', label: 'Allow lets Hydra finish and clears the prompt' })
  assert.deepEqual(sdk.permissions, [{ behavior: 'allow' }])
  const consoleOutput = await b.browser({ args: ['console'] })
  assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught/)
  process.stdout.write('Hydra chat browser smoke passed.\n')
} finally {
  sdk.release(); await b.close(); await server.close()
  rmSync(home, { recursive: true, force: true })
}
