import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commands } from '../src/cli/commands.ts'
import { hydraCheck } from '../src/cli/workers.ts'
import { decidePush } from '../src/core/decide.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-context-smoke-'))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-context-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
mkdirSync(evidence, { recursive: true })
const exec = promisify(execFile)
commands.task(['create', '--key', 'work', '--title', 'Context smoke task', '--brief', 'Check the canary.'])
const server = await startServer({ hydraId: 'default' })

const browser = async ({ args }: { args: string[] }) => {
  const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000 })
  assert.doesNotMatch(stdout, /^error:/m)

  return stdout
}

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['wait', 'Context smoke task'] })
  await browser({
    args: ['eval', `async () => {
    const token = document.querySelector('meta[name="pnyx-token"]').content;
    const socket = new WebSocket(new URL('ws?token=' + token, document.baseURI).href.replace('http', 'ws'));
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let next = 0;
    const command = (name, args) => new Promise((resolve, reject) => {
      const id = 'context-' + next++;
      const timer = setTimeout(() => reject(new Error('Receipt timeout')), 5000);
      const read = event => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer); socket.removeEventListener('message', read);
        if (message.type === 'error') reject(new Error(message.error)); else resolve(message);
      };
      socket.addEventListener('message', read);
      socket.send(JSON.stringify({type:'command', id, name, args}));
    });
    try {
      await command('task', ['brief', 'work', '--brief', 'Check the canary and rollback.']);
      await command('column', ['describe', 'needs_you', '--description', 'Questions requiring an owner answer.']);
      await command('column', ['resize', 'needs_you', '--width', '420']);
      await command('hydra', ['resize', '--width', '480']);
      await command('hydra', ['memory', 'set', '--key', 'review-policy', '--text', 'Check the canary.']);
      await command('task', ['hide', 'work']);
      const hidden = await command('task', ['show', 'work', '--full']);
      if (!hidden.task.hidden || hidden.task.brief !== 'Check the canary and rollback.') throw new Error('Task context lost');
      await command('task', ['unhide', 'work']);
      await command('layout', ['reset']);
      const layout = await command('layout', ['show']);
      if (layout.widths.hydra !== layout.defaults.hydra || Object.keys(layout.widths.columns).length) throw new Error('Widths not reset');
      return 'context API smoke passed';
    } finally { socket.close(); }
  }`],
  })
  await browser({ args: ['wait', 'Context smoke task'] })
  const state = loadHydra({ hydraId: 'default' }).state
  assert.equal(state.cards[state.keys.work!]!.hidden, false)
  assert.equal(state.config?.columns[0]?.description, 'Questions requiring an owner answer.')
  assert.equal(state.hydraMemory?.['review-policy']?.text, 'Check the canary.')
  commands.task(['create', '--key', 'digest', '--title', 'Digest smoke task'])
  const transcript = join(home, 'worker.jsonl')
  writeFileSync(transcript, '')
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const d = decidePush({ state: writer.state, key: 'worker', input: { agent: { provider: 'claude-code', sessionId: 'worker', transcriptPath: transcript }, terminal: { tty: '/dev/ttys123' } }, meta: { at: new Date().toISOString(), actor: 'fixture' } })
      assert.ok('event' in d)
      writer.append({ event: d.event })
    },
  })
  await commands.task(['attach', 'digest', '--session', 'claude-code:worker'])
  const after = loadHydra({ hydraId: 'default' }).state.seq
  writeFileSync(transcript, ['user', 'assistant'].map((role, i) => JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { content: i ? 'The rollout can wait.' : 'Move this to next week.' } })).join('\n') + '\n')
  const digest = await hydraCheck({ args: ['check', '--after', String(after)] })
  assert.match(JSON.stringify(digest.conversations), /Move this to next week/)
  assert.match(JSON.stringify(digest.conversations), /The rollout can wait/)
  await browser({ args: ['wait', 'Digest smoke task'] })
  await browser({ args: ['eval', '() => { [...document.querySelectorAll(\'.card\')].find(card => card.textContent.includes("Digest smoke task")).querySelector(\'.card-open\').click(); return true; }'] })
  await browser({ args: ['wait', 'Move this to next week.'] })
  await browser({ args: ['wait', 'The rollout can wait.'] })
  const screenshot = join(evidence, 'context-smoke.png')
  rmSync(screenshot, { force: true })
  await browser({ args: ['screenshot', screenshot] })
  console.log(`context smoke passed; evidence: ${evidence}`)
} finally {
  await browser({ args: ['close'] }).catch(() => undefined)
  await server.close()
  rmSync(home, { recursive: true, force: true })
}
