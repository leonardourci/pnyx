// Thread interactions against synthetic transcripts and a disposable reply route.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '../src/server/server.ts'
import { decidePush, decideView } from '../src/core/decide.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'
import { seedWebFixture } from './web-fixture.ts'

const exec = promisify(execFile), home = mkdtempSync(join(tmpdir(), 'pnyx-chat-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const markdown = readFileSync(join(import.meta.dirname, 'fixtures/web/chat.md'), 'utf8')
// Enough earlier messages that the first one is on an older page.
appendFileSync(fixture.transcript, Array.from({ length: 70 }, (_, i) => JSON.stringify({ type: 'assistant', timestamp: `2026-10-01T10:00:${String(i).padStart(2, '0')}Z`, message: { content: `Earlier note ${i}` } }) + '\n').join(''))
appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-13T10:50:00Z', message: { content: '**Review** this plan and `safe links`.' } }) + '\n')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T10:51:00Z', message: { content: markdown } }) + '\n')
// A trailing tool call, so with Focus off a trace is the last row.
appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T10:52:00Z', message: { content: [{ type: 'tool_use', name: 'Run checks', input: { command: 'pnpm test' } }] } }) + '\n')
const meta = { actor: 'fixture', at: '2026-10-14T10:00:00Z' }
withWriter({
  board: 'default',
  fn: ({ writer: w }) => {
    const d = decidePush({ state: w.state, key: 'layout', input: { activity: 'running git status', tags: ['an-unbroken-tag-that-needs-to-wrap-inside-a-narrow-card'] }, meta })
    assert.ok('event' in d); w.append({ event: d.event })
  },
})
const server = await startServer({ board: 'default', homes: [fixture.nativeHome] })
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-chat-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
mkdirSync(evidence, { recursive: true })
let step = 'Open the fixture board'

const browser = async ({ args = [] }: { args?: string[] } = {}) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
  assert.doesNotMatch(stdout, /^error:/m)

  return stdout
}

const check = async ({ condition, label }: { condition: string; label: string }) => {
  step = label
  const out = await browser({ args: ['eval', `() => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return 'passed'; }`] })
  assert.match(out, /passed/)
}

const ref = async ({ role, name }: { role: string; name: string }) => {
  const snapshot = await browser({ args: ['snapshot', '--full'] })
  const line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`))
  assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async ({ role, name }: { role: string; name: string }) => browser({ args: ['click', await ref({ role, name })] })
const fill = async ({ name, text }: { name: string; text: string }) => browser({ args: ['fill', await ref({ role: 'textbox', name }), text] })

const press = ({ key }: { key: string }) => {
  step = `Press ${key}`

  return browser({ args: ['press', key] })
}

const focus = ({ selector }: { selector: string }) => {
  step = `Focus ${selector}`

  return browser({ args: ['eval', `() => { document.querySelector(${JSON.stringify(selector)}).focus(); return true; }`] })
}

// The caret is in the messages and inside `block`, an element expression.
const caretIn = ({ block }: { block: string }) => `document.activeElement.matches("[data-caret-host]") && getSelection().isCollapsed && (${block}).contains(getSelection().focusNode)`

const changeView = async ({ patch }: { patch: unknown }) => {
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decideView({ state: w.state, patch, meta }); assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  const revision = loadBoard({ board: 'default' }).state.seq
  await browser({ args: ['eval', `async () => { for (let i = 0; i < 100; i++) { if (Number(document.querySelector('.app').dataset.seq) >= ${revision}) return true; await new Promise(r => setTimeout(r, 100)); } throw new Error('the board never showed event ${revision}'); }`] })
}

const screenshot = async ({ name }: { name: string }) => {
  const path = join(evidence, name); rmSync(path, { force: true })

  try {
    await browser({ args: ['screenshot', path] })
  } catch (error) {
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '1000'] }); await browser({ args: ['wait', 'Needs you'] })
  const platform = await browser({ args: ['eval', "() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'"] })
  const mod = platform.includes('mac') ? 'Meta' : 'Control'
  await click({ role: 'button', name: 'Open conversation for Shape the first working board' })
  await browser({ args: ['wait', 'Thread plan'] })
  await check({ condition: 'document.activeElement.matches(".composer textarea") && document.querySelector(".thread").lastElementChild.matches(".composer")', label: 'opening a card focuses the reply input at the end of the thread' })
  await check({ condition: 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "true" && !document.querySelector(".message.tool, .message.thinking") && document.querySelectorAll(".running").length === 1', label: 'Focus starts on with one running indicator' })
  await check({ condition: 'document.querySelector(".card-footer").textContent.includes("needs you") && !document.querySelector(".card-footer").textContent.includes("running ")', label: 'the declared task status stays visible and Focus hides the running tool' })
  await click({ role: 'switch', name: 'Focus' }); await browser({ args: ['wait', 'Showing tool calls and thinking'] })
  await check({ condition: '!!document.querySelector(".message.tool pre") && !!document.querySelector(".message.thinking pre")', label: 'Focus off shows both trace kinds' })
  await focus({ selector: '.composer textarea' }); await press({ key: 'Escape' })
  await check({ condition: `document.querySelector(".messages > .message:last-child").matches(".tool") && ${caretIn({ block: '[...document.querySelectorAll(".message:not(.mine, .tool, .thinking)")].at(-1)' })}`, label: 'with a trace last, Escape still puts the caret in the latest reply' })
  await press({ key: 'Shift+ArrowDown' }); await press({ key: 'Shift+ArrowDown' }); await press({ key: 'Shift+Enter' })
  await check({ condition: 'document.activeElement.matches(".composer textarea") && document.activeElement.value.startsWith("> Thread plan\\n> A readable") && !/Comment|Enter|type/.test(document.activeElement.value)', label: 'a quote across blocks carries only message text' })
  await browser({ args: ['eval', '() => { const input = document.querySelector(".composer textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); return true; }'] })
  await click({ role: 'switch', name: 'Focus' }); await browser({ args: ['wait', 'Prompts and agent messages only'] })
  await browser({ args: ['open', server.url] }); await browser({ args: ['wait', 'Needs you'] }); await click({ role: 'button', name: 'Open conversation for Shape the first working board' }); await browser({ args: ['wait', 'Thread plan'] })
  await check({ condition: 'document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"', label: 'Focus survives reload' })
  await check({ condition: 'document.querySelectorAll(".markdown h1").length === 1 && !!document.querySelector(".markdown ul li") && !!document.querySelector(".markdown ol li") && !!document.querySelector(".markdown table") && !!document.querySelector(".code-block code") && !!document.querySelector(".task-marker")', label: 'GFM headings, lists, tables, task lists and code blocks render' })
  await check({ condition: '!window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onclick],.messages a[href^=javascript],.messages a[href^=data]") && [...document.querySelectorAll(".messages a")].some(a => a.href === "https://example.com/plan")', label: 'HTML cannot execute and only safe links render' })
  await check({ condition: '[...document.querySelectorAll(".code-block code")].some(el => el.textContent.includes("// END LONG CODE")) && document.querySelectorAll(".code-block").length === 1', label: 'chunked code stays in one Markdown block' })
  await check({ condition: '[...document.querySelectorAll(".markdown p")].some(p => p.textContent.startsWith("Fish & chips, escaped as &amp; in HTML.") && p.querySelector("code").textContent === "&amp;")', label: 'entities decode in text but stay literal in inline code' })
  await browser({ args: ['eval', '() => { window.replyInputNode = document.querySelector(".composer textarea"); window.replyInputRemovals = 0; window.replyObserver = new MutationObserver(records => { for (const record of records) for (const removed of record.removedNodes) if (removed === window.replyInputNode || removed.contains(window.replyInputNode)) window.replyInputRemovals++; }); window.replyObserver.observe(document.querySelector(".detail"), {childList:true,subtree:true}); return true; }'] })
  await check({ condition: '[...document.querySelectorAll(".messages a")].every(a => getComputedStyle(a).webkitUserModify === "read-only")', label: 'links stay read-only in the caret host so they still open' })
  await press({ key: 'Escape' }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement === window.replyInputNode', label: 'Enter focuses the existing reply input' })
  await press({ key: 'Escape' }); await press({ key: 'Escape' }); await press({ key: 'Home' })
  await check({ condition: `${caretIn({ block: 'document.querySelector("[data-message-block]")' })}`, label: 'Home puts the caret in the first block' })
  await press({ key: 'j' }); await check({ condition: 'document.querySelectorAll("[data-active=true]").length === 1 && document.querySelector("[data-active=true]") !== document.querySelector("[data-message-block]")', label: 'j moves the caret to the next block' })
  await press({ key: 'Escape' }); await press({ key: 'End' }); await press({ key: 'c' }); await fill({ name: 'Comment on selected text', text: 'Keep this final step explicit.' }); await press({ key: 'Escape' })
  await check({ condition: `${caretIn({ block: '[...document.querySelectorAll("[data-message-block]")].at(-1)' })} && !document.querySelector(".inline-comment textarea")`, label: 'Escape leaves comment text attached to its block and the caret on it' })
  await press({ key: 'Enter' })
  await check({ condition: 'document.querySelectorAll(".composer textarea").length === 1 && document.activeElement === window.replyInputNode && window.replyInputRemovals === 0', label: 'comment Escape/Enter keeps exactly one mounted reply input' })
  await fill({ name: 'Reply to Shape the first working board', text: 'Regression: send after commenting.' })
  await press({ key: `${mod}+Enter` }); await browser({ args: ['wait', 'Delivered'] })
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /Regression: send after commenting/)
  await check({ condition: 'document.querySelector(".composer textarea") === window.replyInputNode && window.replyInputRemovals === 0 && !document.querySelector(".inline-comment")', label: 'typing and sending after comment navigation keeps the input mounted' })
  await browser({ args: ['eval', '() => { const block = [...document.querySelectorAll("[data-message-block]")].find(el => el.dataset.quote.startsWith("Final step:")); document.querySelector("[data-caret-host]").focus(); getSelection().collapse(block.querySelector("p").firstChild, 0); return true; }'] }); await press({ key: 'c' })
  await fill({ name: 'Comment on selected text', text: 'Keep this final step explicit.' }); await press({ key: 'Escape' }); await press({ key: 'Enter' })
  await fill({ name: 'Reply to Shape the first working board', text: 'Please apply these comments.' })
  await browser({ args: ['eval', '() => { const p = [...document.querySelectorAll(\'.message-block p\')].find(p => p.textContent.startsWith(\'A readable paragraph\')); const range = document.createRange(); range.setStart(p.firstChild, 2); range.setEnd(p.firstChild, 20); const s=window.getSelection(); s.removeAllRanges(); s.addRange(range); p.dispatchEvent(new MouseEvent(\'mouseup\',{bubbles:true})); return true; }'] })
  await browser({ args: ['eval', '() => { document.querySelector(".block-comment-action.has-selection").click(); return true; }'] }); await fill({ name: 'Comment on selected text', text: 'Explain this selected phrase.' }); await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".inline-comment").length === 2 && document.querySelector(".composer").textContent.includes("2 comments go with this reply")', label: 'text selection adds another quoted comment' })
  await browser({ args: ['eval', '() => { const p = [...document.querySelectorAll(\'.message-block p\')].find(p => p.textContent.startsWith(\'A readable paragraph\')); document.querySelector(\'[data-caret-host]\').focus(); const range=document.createRange(); range.selectNodeContents(p); const s=window.getSelection(); s.removeAllRanges(); s.addRange(range); p.dispatchEvent(new MouseEvent(\'mouseup\',{bubbles:true})); return true; }'] })
  await press({ key: 'j' }); await check({ condition: 'document.activeElement.matches(".inline-comment textarea") && document.activeElement.value === "j"', label: 'typing on a selection starts a comment and preserves the first character' })
  await press({ key: 'u' }); await press({ key: 's' }); await press({ key: 't' }); await press({ key: 'Escape' })
  await check({ condition: 'document.querySelectorAll(".inline-comment").length === 3 && [...document.querySelectorAll(".inline-comment p")].some(p => p.textContent === "just")', label: 'subsequent typing stays in the comment' })

  await click({ role: 'button', name: 'Settings' }); await click({ role: 'button', name: 'Back to board' })
  await check({ condition: 'document.querySelectorAll(".inline-comment").length === 3 && document.querySelector(".composer textarea").value === "Please apply these comments."', label: 'comments and reply survive navigation' })
  await check({ condition: 'document.querySelectorAll(".composer .pending-comments li").length === 3 && document.querySelector(".composer .pending-comments").textContent.includes("Explain this selected phrase.")', label: 'the composer lists every comment that goes with the reply' })

  {
    const theme = 'dark'
    await changeView({ patch: { panelWidth: 600 } })
    await check({ condition: '[...document.querySelectorAll(".code-block pre,.markdown-table")].some(el => el.scrollWidth > el.clientWidth)', label: 'wide code or tables scroll within their block' })
    await browser({ args: ['eval', '() => { document.querySelector(".inline-comment").scrollIntoView({block:"center"}); return true; }'] })
    await screenshot({ name: `chat-comments-${theme}.png` })
    await focus({ selector: '.composer textarea' }); await press({ key: 'Escape' }); await check({ condition: caretIn({ block: '[...document.querySelectorAll(".message:not(.mine) [data-message-block]")].at(-1).closest(".message")' }), label: 'Escape puts the caret in the latest reply' }); await press({ key: 'Enter' })
    await check({ condition: 'document.activeElement.matches(".composer textarea")', label: 'Enter returns to inline reply' })
    await screenshot({ name: `chat-reply-${theme}.png` })
  }

  process.stdout.write('Sending quoted comments\n')
  await focus({ selector: '.composer textarea' }); await press({ key: `${mod}+Enter` }); await browser({ args: ['wait', 'Delivered'] })
  const sent = readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8')
  assert.match(sent, /Please apply these comments/); assert.match(sent, /pnyx-comment block=/)
  assert.match(sent, /> Final step: preserve the reply/); assert.match(sent, /Keep this final step explicit/)
  assert.match(sent, /> readable paragraph/); assert.match(sent, /Explain this selected phrase/)
  await check({ condition: '!document.querySelector(".inline-comment") && document.querySelector(".composer textarea").value === ""', label: 'successful delivery clears only the submitted draft and comments' })
  await click({ role: 'button', name: 'Load older messages' }); await browser({ args: ['wait', 'Earlier note 0'] })
  await browser({ args: ['eval', '() => { [...document.querySelectorAll(".detail-tabs button")].find(b => b.textContent === "Agent").click(); return true; }'] })
  await browser({ args: ['eval', '() => { document.querySelector("[data-conversation-tab]").click(); return true; }'] })
  await check({ condition: '[...document.querySelectorAll(".message p")].some(p => p.textContent === "Earlier note 0")', label: 'older pages survive switching tabs' })
  step = 'Switch to mobile emulation (reloads the document), then reopen the card'
  await browser({ args: ['emulate', '--viewport', '390x844x1,mobile,touch'] })
  await browser({ args: ['wait', 'Needs you'] })
  await click({ role: 'button', name: 'Open conversation for Shape the first working board' }); await browser({ args: ['wait', 'Thread plan'] })
  await focus({ selector: '.composer textarea' })
  await check({ condition: 'document.documentElement.scrollWidth === innerWidth && document.querySelector(".thread").scrollWidth <= document.querySelector(".thread").clientWidth + 1', label: 'mobile chat stays within the viewport' })
  await screenshot({ name: 'chat-mobile.png' })
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Chat smoke passed; screenshots: ${evidence}\n`)
} catch (error) {
  writeFileSync(join(evidence, 'chat-failure-step.txt'), `${step}\n${String(error)}\n`)
  await screenshot({ name: 'chat-failure.png' }).catch(() => {})
  writeFileSync(join(evidence, 'chat-failure-snapshot.txt'), await browser({ args: ['snapshot', '--full'] }).catch(String))
  writeFileSync(join(evidence, 'chat-failure-dom.txt'), await browser({ args: ['eval', '--full', '() => ({html:document.documentElement.outerHTML,active:document.activeElement.outerHTML,inputMounted:!!document.querySelector(".composer textarea"),sameInput:document.querySelector(".composer textarea") === window.replyInputNode,removals:window.replyInputRemovals})'] }).catch(String))
  throw error
} finally {
  await server.close(); await browser({ args: ['stop'] }).catch(() => {}); rmSync(home, { recursive: true, force: true })
}
