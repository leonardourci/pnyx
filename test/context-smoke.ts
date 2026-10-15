import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { loadBoard } from '../src/store/board-store.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-context-smoke-'))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `pnyx-context-${process.pid}` }
const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
mkdirSync(evidence, { recursive: true })
const exec = promisify(execFile)
commands.task(['create', '--key', 'work', '--title', 'Context smoke task', '--brief', 'Check the canary.'])
const server = await startServer({ board: 'default' })

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
    const socket = new WebSocket(location.origin.replace('http', 'ws') + '/ws?token=' + token);
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
  const state = loadBoard({ board: 'default' }).state
  assert.equal(state.cards[state.keys.work!]!.hidden, false)
  assert.equal(state.board?.columns[0]?.description, 'Questions requiring an owner answer.')
  assert.equal(state.hydraMemory?.['review-policy']?.text, 'Check the canary.')
  const screenshot = join(evidence, 'context-smoke.png')
  rmSync(screenshot, { force: true })
  await browser({ args: ['screenshot', screenshot] })
  console.log(`context smoke passed; evidence: ${evidence}`)
} finally {
  await browser({ args: ['close'] }).catch(() => undefined)
  await server.close()
  rmSync(home, { recursive: true, force: true })
}
