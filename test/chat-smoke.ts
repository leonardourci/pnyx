import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const { browser, evaluate, check, eventually, click, fill, press, screenshot, close } = smokeBrowser({ home, session: 'pnyx-chat' })
const select = ({ start, end }: { start: number; end: number }) => evaluate({ code: `const p = [...document.querySelectorAll('.detail .message-block p')].find(p => p.textContent.startsWith('A readable paragraph')); const range = document.createRange(); range.setStart(p.firstChild, ${start}); range.setEnd(p.firstChild, ${end}); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true;` })

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '1000'] }); await browser({ args: ['wait', 'Needs you'] })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` }); await browser({ args: ['wait', 'Thread plan'] })
  await click({ selector: '.detail .message-block' })
  await evaluate({ code: 'document.querySelector(".detail .message-block").scrollIntoView({ block: "start" }); return true;' })
  await screenshot({ name: 'message-section.png' })
  await check({ condition: '!document.querySelector(".detail .block-comment-action:not(.has-selection)")', label: 'clicking a message section shows no comment shortcut hint' })
  await evaluate({ code: 'document.querySelector(".detail .thread").focus(); return true;' })
  await press({ key: 'c' })
  await check({ condition: 'document.activeElement.matches(".detail .inline-comment textarea")', label: 'C still opens a comment on the active block' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".detail .markdown h1").length === 1 && !!document.querySelector(".detail .markdown ul li") && !!document.querySelector(".detail .markdown ol li") && !!document.querySelector(".detail .markdown table") && document.querySelectorAll(".detail .code-block").length === 1', label: 'agent reply renders as one complete Markdown document' })
  await check({ condition: '[...document.querySelectorAll(".detail .messages a")].every(a => a.target === "_blank" && a.relList.contains("noopener") && a.relList.contains("noreferrer") && a.contentEditable === "false")', label: 'message links open safely outside the read-only conversation' })
  await check({ condition: '[...document.querySelectorAll(".detail .markdown a")].some(a => a.href === "https://github.com/example/project/pull/42") && !!document.querySelector(".detail .markdown code") && !!document.querySelector(".detail .markdown blockquote")', label: 'bare PR links, inline code and quotes render in messages' })
  await check({ condition: '[...document.querySelectorAll(".detail .markdown")].every(el => el.scrollWidth <= el.clientWidth + 1)', label: 'long code and tables stay inside the message width' })
  await check({ condition: '!window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onclick],.messages a[href^=javascript],.messages a[href^=data]") && [...document.querySelectorAll(".detail .messages a")].some(a => a.href === "https://example.com/plan")', label: 'Markdown keeps safe links and cannot execute HTML' })
  await check({ condition: 'document.querySelector(".detail .message.mine").getBoundingClientRect().right === document.querySelector(".detail .messages").getBoundingClientRect().right', label: 'user bubbles align to the right' })
  await evaluate({ code: 'window.input = document.querySelector(".detail .composer textarea"); return true;' })
  await select({ start: 2, end: 20 }); await click({ selector: '.detail .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'Explain this phrase.' }); await press({ key: 'Escape' })
  await select({ start: 2, end: 10 }); await click({ selector: '.detail .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'What does readable mean?' }); await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".detail .inline-comment").length === 2 && document.querySelectorAll(".detail .pending-comments li").length === 2 && document.querySelector(".detail .composer textarea") === window.input', label: 'nested selections keep independent comments and the mounted composer' })
  await fill({ label: 'Reply to Shape the first working Hydra', value: 'Apply these comments.' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: '!document.querySelector(".detail .inline-comment") && document.querySelector(".detail .composer textarea").value === ""', label: 'delivery clears the submitted comments and draft' })
  const sent = readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8')
  assert.match(sent, /Internal note.*no reply needed/)
  assert.match(sent, /## Comments on your reply from 2026-10-15T10:01:00Z/)
  assert.match(sent, /1\. > readable paragraph/); assert.match(sent, /2\. > readable/)
  assert.match(sent, /Paragraph:/); assert.match(sent, /## Message/); assert.doesNotMatch(sent, /pnyx-comment|-----/)
  await select({ start: 2, end: 10 }); await click({ selector: '.detail .block-comment-action.has-selection' })
  await fill({ label: 'Comment on selected text', value: 'A second round.' }); await press({ key: 'Escape' }); await click({ selector: '.detail .composer-send' })
  await eventually({ condition: '!document.querySelector(".detail .inline-comment")', label: 'second comment delivered' })
  assert.equal((readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8').match(/Internal note/g) ?? []).length, 1)
  await evaluate({ code: 'document.querySelector(".detail").closest(".column-cards").scrollTop = 0; return true;' })
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T10:02:00Z', message: { content: 'A new reply while you read above.' } }) + '\n')
  await eventually({ condition: 'document.querySelector(".detail .messages").textContent.includes("A new reply while you read above.")', label: 'new reply pushed into the open card' })
  await eventually({ condition: '!!document.querySelector(".detail .jump")', label: 'new messages offer Jump to latest while the column is scrolled up' })
  await click({ selector: '.detail .jump' })
  await check({ condition: 'document.querySelector(".detail .composer").getBoundingClientRect().bottom <= document.querySelector(".detail").closest(".column-cards").getBoundingClientRect().bottom + 2', label: 'Jump to latest scrolls the column to its composer' })
  await screenshot({ name: 'chat.png' })
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught/)
  process.stdout.write('Conversation browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
