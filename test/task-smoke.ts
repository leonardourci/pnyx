import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decidePush } from '../src/core/decide.ts'
import { startServer } from '../src/server/server.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'
import { commands } from '../src/cli/commands.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-task-smoke-'))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
const exec = promisify(execFile)
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-tasks-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
mkdirSync(evidence, { recursive: true })
withWriter({
  board: 'default',
  fn: ({ writer }) => {
    for (const [key, title] of [['task', 'Attachment test task'], ['a', 'Alpha work'], ['b', 'Beta work'], ['background', 'Background run marker']]) {
      const transcript = join(home, `${key}.jsonl`)
      writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${title} message from its session` }] } })}\n`)
      const input = key === 'task' ? { title, workspace: 'Focused', tags: ['focused'] } : {
        title,
        agent: { provider: 'claude-code', sessionId: key, transcriptPath: transcript },
        ...(key === 'background' ? {} : { terminal: { tty: '/dev/ttys123', pid: '123' } }),
        source: { adapter: 'hooks', instanceId: 'claude', objectId: key },
      }
      const decision = decidePush({ state: writer.state, key: key!, input, meta: { at: '2026-10-14T12:00:00Z', actor: 'fixture' } })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    }
  },
})
commands.board(['create', 'default', '--hydra', 'fixture'])
const server = await startServer({ board: 'default' })

async function browser({ args }: { args: string[] }): Promise<string> {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000 })
  assert.doesNotMatch(stdout, /^error:/m)

  return stdout
}

const evaluate = ({ code }: { code: string }) => browser({ args: ['eval', `() => { ${code} }`] })
const click = ({ text }: { text: string }) => evaluate({ code: `const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing button'); button.click(); return true;` })
const wait = ({ text }: { text: string }) => browser({ args: ['wait', text] })
const fill = ({ label, text }: { label: string; text: string }) => evaluate({ code: `const input = [...document.querySelectorAll('input')].find(i => i.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!input) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', {bubbles: true})); return true;` })

const controls = async () => {
  await evaluate({ code: 'const agent = [...document.querySelectorAll(\'.detail-tabs button\')].find(b => b.textContent.trim() === \'Agent\'); if (agent) agent.click(); const section = document.querySelector(\'[aria-label="Task agent"]\'); const details = section?.closest(\'details\'); if (details) details.open = true; return true;' })
}

const attach = async ({ title }: { title: string }) => {
  await controls()
  await evaluate({ code: 'document.querySelector(\'[aria-label="Attach agent session"]\').click(); return true;' })
  await evaluate({ code: `const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes(${JSON.stringify(title)})); if (!option) throw new Error('Missing session'); option.click(); return true;` })
  await wait({ text: 'Agent attached.' })
}

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['emulate', '--viewport', '1440x900x1'] })
  await wait({ text: 'Attachment test task' })
  await evaluate({ code: 'if ([...document.querySelectorAll(\'.card\')].some(e => e.textContent.includes(\'Background run marker\'))) throw new Error(\'Background card visible\'); return true;' })
  await evaluate({ code: 'document.querySelector(\'.card-open\').click(); return true;' })
  await evaluate({ code: 'if (!document.querySelector(\'.column-cards > .detail\')) throw new Error(\'Task conversation did not expand inline\'); return true;' })
  await attach({ title: 'Alpha work' })
  await wait({ text: 'Alpha work message from its session' })
  assert.equal(loadBoard({ board: 'default' }).state.cards.c1!.agent?.sessionId, 'a')
  await controls()
  await click({ text: 'Detach agent' })
  await wait({ text: 'Agent detached.' })
  await attach({ title: 'Beta work' })
  await wait({ text: 'Beta work message from its session' })
  await evaluate({ code: 'const thread = document.querySelector(\'[aria-label="Agent conversation"]\'); if (thread.textContent.includes(\'Alpha work message\')) throw new Error(\'Previous session leaked into chat\'); return true;' })
  assert.equal(loadBoard({ board: 'default' }).state.cards.c1!.agent?.sessionId, 'b')
  await click({ text: 'Send to Hydra' })
  await wait({ text: 'Task posted in Hydra’s chat' })
  await click({ text: 'Create a worker' })
  await wait({ text: 'Worker request posted in Hydra’s chat' })
  assert.equal(loadBoard({ board: 'default' }).state.hydraMessages?.length, 2)
  await evaluate({ code: 'document.querySelector(\'[aria-label="Close detail"]\').click(); return true;' })
  await browser({ args: ['wait', '150'] })
  await evaluate({
    code: `
    const toggle = document.querySelector('.hydra-chat > button');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const send = WebSocket.prototype.send;
    window.pendingHydra = [];
    WebSocket.prototype.send = function(data) {
      const message = typeof data === 'string' ? JSON.parse(data) : {};
      if (message.type === 'command' && message.name === 'hydra') {
        window.pendingHydra.push({ socket: this, data });
        return;
      }
      return send.call(this, data);
    };
    window.releaseHydra = () => {
      WebSocket.prototype.send = send;
      window.pendingHydra.forEach(item => send.call(item.socket, item.data));
    };
    return true;
  `,
  })
  await fill({ label: 'Message Hydra', text: 'Pending Hydra question' })
  await evaluate({
    code: `
    const form = document.querySelector('[aria-label="Message Hydra"]').form;
    form.requestSubmit(); form.requestSubmit(); return true;
  `,
  })
  await fill({ label: 'Message Hydra', text: 'Keep this next question' })
  await evaluate({ code: 'window.releaseHydra(); return true;' })
  await wait({ text: 'Pending Hydra question' })
  await browser({
    args: ['eval', `async () => {
    for (let i = 0; i < 50; i++) {
      const input = document.querySelector('[aria-label="Message Hydra"]');
      if (input.form.getAttribute('aria-busy') !== 'true') {
        if (input.value !== 'Keep this next question') throw new Error('New Hydra draft lost');
        if (window.pendingHydra.length !== 1) throw new Error('Hydra submission duplicated');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Hydra receipt did not settle');
  }`],
  })
  assert.equal(loadBoard({ board: 'default' }).state.hydraMessages?.length, 3)
  await evaluate({ code: 'document.querySelector(\'[aria-label="Workspace"]\').click(); return true;' })
  await evaluate({ code: 'const option = [...document.querySelectorAll(\'[role="option"]\')].find(e => e.textContent.trim() === "Focused"); option.click(); return true;' })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Filter by tag"]\').click(); return true;' })
  await evaluate({ code: 'const option = [...document.querySelectorAll(\'[role="option"]\')].find(e => e.textContent.trim() === "focused"); option.click(); return true;' })
  await fill({ label: 'Find a card', text: 'Attachment test task' })
  await evaluate({ code: 'const add = [...document.querySelector(\'[data-column="parked"]\').querySelectorAll(\'button\')].find(b => b.textContent.trim() === \'+ Add task\'); add.click(); return true;' })
  await browser({ args: ['eval', 'async () => { for (let i = 0; i < 100; i++) { if (document.querySelector(\'[aria-label="Rename task New task"]\')) return true; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(\'New task editor hidden by filters\'); }'] })
  await wait({ text: 'New task' })
  await evaluate({ code: 'if (document.querySelector(\'[aria-label="Find a card"]\').value !== \'\') throw new Error(\'Task creation did not clear filters\'); return true;' })
  await evaluate({ code: 'if (document.activeElement?.getAttribute(\'aria-label\') !== \'Rename task New task\') throw new Error(\'New task title not focused\'); return true;' })
  await fill({ label: 'Rename task New task', text: 'Hydra browser task' })
  await click({ text: 'Save title' })
  await wait({ text: 'Hydra browser task' })
  await evaluate({ code: 'const card = [...document.querySelectorAll(\'.card\')].find(c => c.textContent.includes(\'Hydra browser task\')); [...card.querySelectorAll(\'button\')].find(b => b.textContent.trim() === \'+ Subtask\').click(); return true;' })
  await wait({ text: 'New subtask' })
  await fill({ label: 'Rename task New subtask', text: 'Browser subtask' })
  await click({ text: 'Save title' })
  await wait({ text: 'Browser subtask' })
  assert.equal(Object.values(loadBoard({ board: 'default' }).state.cards).filter(c => c.parentId).length, 1)
  await click({ text: '+ Add column' })
  await wait({ text: 'New column' })
  await evaluate({ code: 'if (document.activeElement?.getAttribute(\'aria-label\') !== \'Rename New column column\') throw new Error(\'New column title not focused\'); if (!document.activeElement.closest(\'.column\')) throw new Error(\'Placeholder is outside real column\'); return true;' })
  await fill({ label: 'Rename New column column', text: 'Draft research' })
  await click({ text: 'Save title' })
  await wait({ text: 'Draft research' })
  await evaluate({ code: 'const button = [...document.querySelectorAll(\'.column-header button\')].find(b => b.textContent.trim() === \'Draft research\'); button.dispatchEvent(new MouseEvent(\'dblclick\', {bubbles: true})); return true;' })
  await fill({ label: 'Rename Draft research column', text: 'Research' })
  await click({ text: 'Save title' })
  await wait({ text: 'Research' })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Move Research left"]\').click(); return true;' })
  await browser({ args: ['wait', '150'] })
  assert.equal(loadBoard({ board: 'default' }).state.board?.columns[3]?.title, 'Research')
  await evaluate({ code: 'const task = [...document.querySelectorAll(\'.card .inline-title\')].find(c => c.textContent.trim() === \'Hydra browser task\').closest(\'.card\'); const dest = [...document.querySelectorAll(\'.column\')].find(c => c.getAttribute(\'aria-label\') === \'Research\'); const dt = new DataTransfer(); task.dispatchEvent(new DragEvent(\'dragstart\', {bubbles: true, dataTransfer: dt})); dest.dispatchEvent(new DragEvent(\'drop\', {bubbles: true, dataTransfer: dt})); return true;' })
  await browser({ args: ['wait', '150'] })
  const moved = Object.values(loadBoard({ board: 'default' }).state.cards).find(c => c.title === 'Hydra browser task')!
  assert.equal(moved.column, loadBoard({ board: 'default' }).state.board?.columns[3]?.id)
  await evaluate({ code: 'document.querySelector(\'[aria-label="Delete Research column"]\').click(); return true;' })
  await click({ text: 'Delete column' })
  await browser({ args: ['wait', '150'] })
  assert.equal(loadBoard({ board: 'default' }).state.board?.columns.length, 4)
  await click({ text: 'Undo' })
  await wait({ text: 'Column and its cards restored.' })
  assert.equal(loadBoard({ board: 'default' }).state.board?.columns.length, 5)
  assert.equal(loadBoard({ board: 'default' }).state.cards[moved.id]?.column, moved.column)
  await evaluate({ code: 'document.querySelector(\'[aria-label="Delete Research column"]\').click(); return true;' })
  await click({ text: 'Delete column' })
  await browser({ args: ['wait', '150'] })
  await evaluate({ code: 'if (document.querySelector(\'[role="dialog"]\')) throw new Error(\'Unexpected modal\'); const columns = [...document.querySelectorAll(\'.column\')]; const from = columns[3]; const to = columns[0]; const dt = new DataTransfer(); from.querySelector(\'.column-header\').dispatchEvent(new DragEvent(\'dragstart\', {bubbles: true, dataTransfer: dt})); to.dispatchEvent(new DragEvent(\'drop\', {bubbles: true, dataTransfer: dt})); return true;' })
  await browser({ args: ['wait', '150'] })
  assert.equal(loadBoard({ board: 'default' }).state.board?.columns[0]?.id, 'parked')
  await evaluate({ code: 'const columns = [...document.querySelectorAll(\'.column\')]; const dt = new DataTransfer(); columns[0].querySelector(\'.column-header\').dispatchEvent(new DragEvent(\'dragstart\', {bubbles: true, dataTransfer: dt})); columns.at(-1).dispatchEvent(new DragEvent(\'drop\', {bubbles: true, dataTransfer: dt})); return true;' })
  await browser({ args: ['wait', '150'] })
  assert.equal(loadBoard({ board: 'default' }).state.board?.columns.at(-1)?.id, 'parked')
  await evaluate({ code: 'const toggle = document.querySelector(\'.hydra-chat > button\'); if (toggle.getAttribute(\'aria-expanded\') !== \'true\') toggle.click(); return true;' })
  await fill({ label: 'Message Hydra', text: '- check the CI' })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Message Hydra"]\').form.requestSubmit(); return true;' })
  await browser({ args: ['wait', '150'] })
  const question = loadBoard({ board: 'default' }).state.hydraMessages?.at(-1)
  assert.equal(question?.text, '- check the CI')
  assert.equal(question?.task, undefined)
  const screenshot = join(evidence, 'task-attachment.png')
  rmSync(screenshot, { force: true })

  try {
    await browser({ args: ['screenshot', screenshot] })
  } catch (error) {
    // Some versions save the PNG but omit its path from the CLI response.
    if (!existsSync(screenshot)
      || readFileSync(screenshot).subarray(0, 8)
        .toString('hex') !== '89504e470d0a1a0a') {
      throw error
    }
  }

  process.stdout.write('Task attachment/chat switching, Hydra requests, inline tasks/subtasks and column editing/dragging passed.\n')
} finally {
  await server.close()
  await browser({ args: ['stop'] }).catch(() => {})
  rmSync(home, { recursive: true, force: true })
}
