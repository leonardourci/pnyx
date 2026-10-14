// Real browser attachment flow against a disposable board and synthetic sessions.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decidePush } from '../src/core/decide.ts'
import { startServer } from '../src/server/server.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-task-smoke-'))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
const exec = promisify(execFile)
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-tasks-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
mkdirSync(evidence, { recursive: true })
withWriter('default', writer => {
  for (const [key, title] of [['task', 'Attachment test task'], ['a', 'Alpha work'], ['b', 'Beta work'], ['background', 'Background run marker']]) {
    const transcript = join(home, `${key}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${title} message from its session` }] } })}\n`)
    const input = key === 'task' ? { title } : {
      title,
      agent: { provider: 'claude-code', sessionId: key, transcriptPath: transcript },
      ...(key === 'background' ? {} : { terminal: { tty: '/dev/ttys123', pid: '123' } }),
      source: { adapter: 'hooks', instanceId: 'claude', objectId: key },
    }
    const decision = decidePush(writer.state, key!, input, { at: '2026-10-14T12:00:00Z', actor: 'fixture' })
    assert.ok('event' in decision)
    writer.append(decision.event)
  }
})
const server = await startServer({ board: 'default' })

async function browser({ args }: { args: string[] }): Promise<string> {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000 })
  assert.doesNotMatch(stdout, /^error:/m)

  return stdout
}

const evaluate = ({ code }: { code: string }) => browser({ args: ['eval', `() => { ${code} }`] })
const click = ({ text }: { text: string }) => evaluate({ code: `const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing button'); button.click(); return true;` })
const wait = ({ text }: { text: string }) => browser({ args: ['wait', text] })

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
  await evaluate({ code: 'if ([...document.querySelectorAll(\'.card h3\')].some(e => e.textContent.includes(\'Background run marker\'))) throw new Error(\'Background card visible\'); return true;' })
  await click({ text: 'Attachment test task' })
  await attach({ title: 'Alpha work' })
  await wait({ text: 'Alpha work message from its session' })
  assert.equal(loadBoard('default').state.cards.c1!.agent?.sessionId, 'a')
  await controls()
  await click({ text: 'Detach agent' })
  await wait({ text: 'Agent detached.' })
  await attach({ title: 'Beta work' })
  await wait({ text: 'Beta work message from its session' })
  await evaluate({ code: 'const thread = document.querySelector(\'[aria-label="Agent conversation"]\'); if (thread.textContent.includes(\'Alpha work message\')) throw new Error(\'Previous session leaked into chat\'); return true;' })
  assert.equal(loadBoard('default').state.cards.c1!.agent?.sessionId, 'b')
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

  process.stdout.write('Task attach/detach, background visibility and conversation switching passed.\n')
} finally {
  await server.close()
  await browser({ args: ['stop'] }).catch(() => {})
}
