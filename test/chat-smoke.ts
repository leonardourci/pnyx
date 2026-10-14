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
const fixture = seedWebFixture(home)
const markdown = readFileSync(join(import.meta.dirname, 'fixtures/web/chat.md'), 'utf8')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-13T10:50:00Z', message: { content: '**Review** this plan and `safe links`.' } }) + '\n')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T10:51:00Z', message: { content: markdown } }) + '\n')
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

const browser = async (...args: string[]) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
  assert.doesNotMatch(stdout, /^error:/m)

  return stdout
}

const check = async (condition: string, label: string) => {
  step = label
  const out = await browser('eval', `() => { if (!(${condition})) throw new Error(${JSON.stringify(label)}); return 'passed'; }`)
  assert.match(out, /passed/)
}

const ref = async (role: string, name: string) => {
  const snapshot = await browser('snapshot', '--full')
  const line = snapshot.split('\n').find(l => l.includes(`${role} ${JSON.stringify(name)}`))
  assert.ok(line, `missing ${role}: ${name}`)

  return '@' + /uid=([^ ]+)/.exec(line)![1]
}

const click = async (role: string, name: string) => browser('click', await ref(role, name))
const fill = async (name: string, text: string) => browser('fill', await ref('textbox', name), text)

const press = (key: string) => {
  step = `Press ${key}`

  return browser('press', key)
}

const focus = (selector: string) => {
  step = `Focus ${selector}`

  return browser('eval', `() => { document.querySelector(${JSON.stringify(selector)}).focus(); return true; }`)
}

const changeView = async (patch: unknown) => {
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const d = decideView({ state: w.state, patch, meta }); assert.ok('event' in d); w.append({ event: d.event })
    },
  })
  const revision = loadBoard({ board: 'default' }).state.seq
  await browser('wait', `${revision} recorded events`)
}

const screenshot = async (name: string) => {
  const path = join(evidence, name); rmSync(path, { force: true })

  try {
    await browser('screenshot', path)
  } catch (error) {
    if (!existsSync(path) || readFileSync(path).subarray(0, 8)
      .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }
}

try {
  await browser('open', server.url); await browser('resize', '1440', '1000'); await browser('wait', 'The working board')
  const platform = await browser('eval', "() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'")
  const mod = platform.includes('mac') ? 'Meta' : 'Control'
  await click('button', 'Shape the first working board')
  await browser('wait', 'Thread plan')
  await check('document.activeElement.matches(".composer textarea") && document.querySelector(".thread").lastElementChild.matches(".composer")', 'opening a card focuses the reply input at the end of the thread')
  await check('document.querySelector("[role=switch]").getAttribute("aria-checked") === "true" && !document.querySelector(".message.tool, .message.thinking") && document.querySelectorAll(".running").length === 1', 'Focus starts on with one running indicator')
  await check('document.querySelector(".card-footer").textContent.includes("working") && !document.querySelector(".card-footer").textContent.includes("running ")', 'Focus hides the running tool on the card')
  await click('switch', 'Focus'); await browser('wait', 'Showing tool calls and thinking')
  await check('!!document.querySelector(".message.tool pre") && !!document.querySelector(".message.thinking pre")', 'Focus off shows both trace kinds')
  await click('switch', 'Focus'); await browser('wait', 'Prompts and agent messages only')
  await browser('open', server.url); await browser('wait', 'The working board'); await click('button', 'Shape the first working board'); await browser('wait', 'Thread plan')
  await check('document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"', 'Focus survives reload')
  await check('document.querySelectorAll(".markdown h1").length === 1 && !!document.querySelector(".markdown ul li") && !!document.querySelector(".markdown ol li") && !!document.querySelector(".markdown table") && !!document.querySelector(".syntax-keyword") && !!document.querySelector(".task-marker")', 'GFM headings, lists, tables, task lists and highlighted code render')
  await check('!window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onclick],.messages a[href^=javascript],.messages a[href^=data]") && [...document.querySelectorAll(".messages a")].some(a => a.href === "https://example.com/plan")', 'HTML cannot execute and only safe links render')
  await check('[...document.querySelectorAll(".code-block code")].some(el => el.textContent.includes("// END LONG CODE")) && document.querySelectorAll(".code-block").length === 1', 'chunked code stays in one Markdown block')
  await browser('eval', '() => { window.replyInputNode = document.querySelector(".composer textarea"); window.replyInputRemovals = 0; window.replyObserver = new MutationObserver(records => { for (const record of records) for (const removed of record.removedNodes) if (removed === window.replyInputNode || removed.contains(window.replyInputNode)) window.replyInputRemovals++; }); window.replyObserver.observe(document.querySelector(".detail"), {childList:true,subtree:true}); return true; }')
  await press('Escape'); await press('Enter')
  await check('document.activeElement === window.replyInputNode', 'Enter focuses the existing reply input')
  await press('Escape'); await press('Home')
  await check('document.activeElement.matches("[data-message-block]")', 'Home selects first block')
  await press('j'); await check('document.querySelectorAll("[data-active=true]").length === 1', 'j advances selected block')
  await press('End'); await press('c'); await fill('Comment on selected text', 'Keep this final step explicit.'); await press('Escape')
  await check('document.activeElement.matches("[data-message-block]") && !document.querySelector(".inline-comment textarea")', 'Escape leaves comment text attached to its block')
  await press('Enter')
  await check('document.querySelectorAll(".composer textarea").length === 1 && document.activeElement === window.replyInputNode && window.replyInputRemovals === 0', 'comment Escape/Enter keeps exactly one mounted reply input')
  await fill('Reply to Shape the first working board', 'Regression: send after commenting.')
  await press(`${mod}+Enter`); await browser('wait', 'Delivered')
  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /Regression: send after commenting/)
  await check('document.querySelector(".composer textarea") === window.replyInputNode && window.replyInputRemovals === 0 && !document.querySelector(".inline-comment")', 'typing and sending after comment navigation keeps the input mounted')
  await browser('eval', '() => { [...document.querySelectorAll("[data-message-block]")].find(el => el.dataset.quote.startsWith("Final step:")).focus(); return true; }'); await press('c')
  await fill('Comment on selected text', 'Keep this final step explicit.'); await press('Escape'); await press('Enter')
  await fill('Reply to Shape the first working board', 'Please apply these comments.')
  await browser('eval', '() => { const p = [...document.querySelectorAll(\'.message-block p\')].find(p => p.textContent.startsWith(\'A readable paragraph\')); const range = document.createRange(); range.setStart(p.firstChild, 2); range.setEnd(p.firstChild, 20); const s=window.getSelection(); s.removeAllRanges(); s.addRange(range); p.dispatchEvent(new MouseEvent(\'mouseup\',{bubbles:true})); return true; }')
  await browser('eval', '() => { document.querySelector(".block-comment-action.has-selection").click(); return true; }'); await fill('Comment on selected text', 'Explain this selected phrase.'); await press('Escape')
  await check('document.querySelectorAll(".inline-comment").length === 2 && document.querySelector(".composer").textContent.includes("2 comments go with this reply")', 'text selection adds another quoted comment')
  await browser('eval', '() => { const p = [...document.querySelectorAll(\'.message-block p\')].find(p => p.textContent.startsWith(\'A readable paragraph\')); p.closest(\'[data-message-block]\').focus(); const range=document.createRange(); range.selectNodeContents(p); const s=window.getSelection(); s.removeAllRanges(); s.addRange(range); p.dispatchEvent(new MouseEvent(\'mouseup\',{bubbles:true})); return true; }')
  await press('j'); await check('document.activeElement.matches(".inline-comment textarea") && document.activeElement.value === "j"', 'typing on a selection starts a comment and preserves the first character')
  await press('u'); await press('s'); await press('t'); await press('Escape')
  await check('document.querySelectorAll(".inline-comment").length === 3 && [...document.querySelectorAll(".inline-comment p")].some(p => p.textContent === "just")', 'subsequent typing stays in the comment')

  await click('button', 'Settings'); await click('button', 'Back to board')
  await check('document.querySelectorAll(".inline-comment").length === 3 && document.querySelector(".composer textarea").value === "Please apply these comments."', 'comments and reply survive navigation')

  {
    const theme = 'dark'
    await changeView({ panelWidth: 600 })
    await check('[...document.querySelectorAll(".code-block pre,.markdown-table")].some(el => el.scrollWidth > el.clientWidth)', 'wide code or tables scroll within their block')
    await browser('eval', '() => { document.querySelector(".inline-comment").scrollIntoView({block:"center"}); return true; }')
    await screenshot(`chat-comments-${theme}.png`)
    await focus('.composer textarea'); await press('Escape'); await check('document.activeElement.matches(".thread")', 'Escape returns to transcript'); await press('Enter')
    await check('document.activeElement.matches(".composer textarea")', 'Enter returns to inline reply')
    await screenshot(`chat-reply-${theme}.png`)
  }

  process.stdout.write('Sending quoted comments\n')
  await focus('.composer textarea'); await press(`${mod}+Enter`); await browser('wait', 'Delivered')
  const sent = readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8')
  assert.match(sent, /Please apply these comments/); assert.match(sent, /pnyx-comment block=/)
  assert.match(sent, /> Final step: preserve the reply/); assert.match(sent, /Keep this final step explicit/)
  assert.match(sent, /> readable paragraph/); assert.match(sent, /Explain this selected phrase/)
  await check('!document.querySelector(".inline-comment") && document.querySelector(".composer textarea").value === ""', 'successful delivery clears only the submitted draft and comments')
  step = 'Switch to mobile emulation (reloads the document), then reopen the card'
  await browser('emulate', '--viewport', '390x844x1,mobile,touch')
  await browser('wait', 'The working board')
  await click('button', 'Shape the first working board'); await browser('wait', 'Thread plan')
  await focus('.composer textarea')
  await check('document.documentElement.scrollWidth === innerWidth && document.querySelector(".thread").scrollWidth <= document.querySelector(".thread").clientWidth + 1', 'mobile chat stays within the viewport')
  await screenshot('chat-mobile.png')
  const consoleOutput = await browser('console'); assert.doesNotMatch(consoleOutput, /(?:TypeError|ReferenceError|Uncaught)/)
  process.stdout.write(`Chat smoke passed; screenshots: ${evidence}\n`)
} catch (error) {
  writeFileSync(join(evidence, 'chat-failure-step.txt'), `${step}\n${String(error)}\n`)
  await screenshot('chat-failure.png').catch(() => {})
  writeFileSync(join(evidence, 'chat-failure-snapshot.txt'), await browser('snapshot', '--full').catch(String))
  writeFileSync(join(evidence, 'chat-failure-dom.txt'), await browser('eval', '--full', '() => ({html:document.documentElement.outerHTML,active:document.activeElement.outerHTML,inputMounted:!!document.querySelector(".composer textarea"),sameInput:document.querySelector(".composer textarea") === window.replyInputNode,removals:window.replyInputRemovals})').catch(String))
  throw error
} finally {
  await server.close(); await browser('stop').catch(() => {}); rmSync(home, { recursive: true, force: true })
}
