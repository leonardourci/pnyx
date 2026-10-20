import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydraSdk } from './hydra-host-fixture.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-chat-smoke-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const markdown = readFileSync(join(import.meta.dirname, 'fixtures/web/chat.md'), 'utf8')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-15T10:00:00Z', message: { content: 'Review this plan.' } }) + '\n')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T10:01:00Z', message: { content: markdown } }) + '\n')
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    for (const [actor, text, at] of [['web', 'Review this plan.', '2026-10-15T10:00:00Z'], ['hydra', markdown, '2026-10-15T10:01:00Z']]) {
      const decision = hydraEvent({ state: writer.state, meta: { actor: actor!, at: at! }, cardId: '$board', change: { type: 'hydra.message', data: { action: 'send', text: text!, hydra: 'hydra' } } })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    }
  },
})
const server = await startServer({ hydraId: 'default', query: hydraSdk().query, homes: [fixture.nativeHome] })
const { browser, evaluate, check, eventually, click, fill, press, screenshot, close } = smokeBrowser({ home, session: 'pnyx-chat' })
const select = ({ start, end }: { start: number; end: number }) => evaluate({ code: `const p = [...document.querySelectorAll('.hydra-chat .message-block p')].find(p => p.textContent.startsWith('A readable paragraph')); const range = document.createRange(); range.setStart(p.firstChild, ${start}); range.setEnd(p.firstChild, ${end}); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true;` })

try {
  await commands.hydra(['send', '--text', 'Initialize chat smoke.'])

  for (let attempt = 0; attempt < 100; attempt++) {
    if (loadHydra({ hydraId: 'default' }).state.cards['$hydra']?.sessionActivity === 'finished') {
      break
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '1000'] }); await browser({ args: ['wait', 'Needs you'] })
  await browser({ args: ['wait', 'Thread plan'] })
  await click({ selector: '.hydra-chat .message-block' })
  await evaluate({ code: 'document.querySelector(".hydra-chat .message-block").scrollIntoView({ block: "start" }); return true;' })
  await screenshot({ name: 'message-section.png' })
  await check({ condition: '!document.querySelector(".hydra-chat .block-comment-action:not(.has-selection)")', label: 'clicking a message section shows no comment shortcut hint' })
  await evaluate({ code: 'document.querySelector(".hydra-chat .hydra-messages").focus(); return true;' })
  await press({ key: 'c' })
  await check({ condition: 'document.activeElement.matches(".hydra-chat .inline-comment textarea")', label: 'C still opens a comment on the active block' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".hydra-chat .markdown h1").length === 1 && !!document.querySelector(".hydra-chat .markdown ul li") && !!document.querySelector(".hydra-chat .markdown ol li") && !!document.querySelector(".hydra-chat .markdown table") && document.querySelectorAll(".hydra-chat .code-block").length === 1', label: 'agent reply renders as one complete Markdown document' })
  await check({ condition: '[...document.querySelectorAll(".hydra-chat .messages a")].every(a => a.target === "_blank" && a.relList.contains("noopener") && a.relList.contains("noreferrer") && a.contentEditable === "false")', label: 'message links open safely outside the read-only conversation' })
  await check({ condition: '[...document.querySelectorAll(".hydra-chat .markdown a")].some(a => a.href === "https://github.com/example/project/pull/42") && !!document.querySelector(".hydra-chat .markdown code") && !!document.querySelector(".hydra-chat .markdown blockquote")', label: 'bare PR links, inline code and quotes render in messages' })
  await check({ condition: '[...document.querySelectorAll(".hydra-chat .markdown")].every(el => el.scrollWidth <= el.clientWidth + 1)', label: 'long code and tables stay inside the message width' })
  await check({ condition: '!window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onclick],.messages a[href^=javascript],.messages a[href^=data]") && [...document.querySelectorAll(".hydra-chat .messages a")].some(a => a.href === "https://example.com/plan")', label: 'Markdown keeps safe links and cannot execute HTML' })
  await check({ condition: 'document.querySelector(".hydra-chat .message.mine").getBoundingClientRect().right === document.querySelector(".hydra-chat .messages").getBoundingClientRect().right', label: 'user bubbles align to the right' })
  await evaluate({ code: 'window.input = document.querySelector(".hydra-chat .composer textarea"); return true;' })
  await select({ start: 2, end: 20 }); await click({ selector: '.hydra-chat .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'Explain this phrase.' }); await press({ key: 'Escape' })
  await select({ start: 2, end: 10 }); await click({ selector: '.hydra-chat .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'What does readable mean?' }); await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".hydra-chat .inline-comment").length === 2 && document.querySelectorAll(".hydra-chat .pending-comments li").length === 2 && document.querySelector(".hydra-chat .composer textarea") === window.input', label: 'nested selections keep independent comments and the mounted composer' })
  await fill({ label: 'Reply to Hydra', value: 'Apply these comments.' }); await click({ selector: '.hydra-chat .composer-send' })
  await eventually({ condition: '!document.querySelector(".hydra-chat .inline-comment") && document.querySelector(".hydra-chat .composer textarea").value === ""', label: 'delivery clears the submitted comments and draft' })
  const sent = loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.text ?? ''
  assert.match(sent, /Internal note.*no reply needed/)
  assert.match(sent, /## Comments on your reply from 2026-10-15T10:01:00Z/)
  assert.match(sent, /1\. > readable paragraph/); assert.match(sent, /2\. > readable/)
  assert.match(sent, /Paragraph:/); assert.match(sent, /## Message/); assert.doesNotMatch(sent, /pnyx-comment|-----/)
  await select({ start: 2, end: 10 }); await click({ selector: '.hydra-chat .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'A second round.' }); await press({ key: 'Escape' }); await click({ selector: '.hydra-chat .composer-send' })
  await eventually({ condition: '!document.querySelector(".hydra-chat .inline-comment")', label: 'second comment delivered' })
  assert.equal((loadHydra({ hydraId: 'default' }).state.hydraMessages?.filter(message => message.actor === 'web').map(message => message.text)
    .join('\n')
    .match(/Internal note/g) ?? []).length, 1)
  await screenshot({ name: 'chat.png' })
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught/)
  process.stdout.write('Conversation browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
