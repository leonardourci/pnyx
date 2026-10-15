import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands, type Output } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { decidePush } from '../src/core/decide.ts'
import { DEFAULT_WIDTHS, viewFor } from '../src/core/view.ts'
import { emptyBoard, replay } from '../src/core/reducer.ts'
import { loadBoard, readEvents, withWriter } from '../src/store/board-store.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-context-')))
  process.env.PNYX_HOME = home
  const run = ({ name, args = [], board = 'default' }: { name: keyof typeof commands; args?: string[]; board?: string }): Output | Promise<Output> => commands[name]([...args, '--board', board])
  const state = () => loadBoard({ board: 'default' }).state
  const push = ({ key, input }: { key: string; input: object }) => withWriter({
    board: 'default',
    fn: ({ writer }) => {
      const d = decidePush({ state: writer.state, key, input, meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })

      if ('event' in d) {
        writer.append({ event: d.event })
      }
    },
  })

  return { home, run, state, push }
}

test('brief and visibility events replay without dropping history or reacting to status', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work', '--brief', 'Check the canary.', '--column', 'workers_on_it'] })
    const id = f.state().keys.work!
    await f.run({ name: 'task', args: ['brief', 'work', '--brief', 'Check the canary and rollback.', '--event-id', 'brief-v2'] })
    const seq = f.state().seq
    await f.run({ name: 'task', args: ['brief', 'work', '--brief', 'Ignored retry', '--event-id', 'brief-v2'] })
    assert.equal(f.state().seq, seq)
    await f.run({ name: 'task', args: ['hide', 'work'] })
    assert.equal(f.state().cards[id]?.hidden, true)
    assert.match(JSON.stringify(await f.run({ name: 'task', args: ['list'] })), /none: no tasks/)
    assert.match(JSON.stringify(await f.run({ name: 'task', args: ['show', 'work'] })), /Check the canary and rollback/)
    await f.run({ name: 'task', args: ['status', 'work', 'done'] })
    assert.equal(f.state().cards[id]?.column, 'workers_on_it')
    assert.equal(f.state().cards[id]?.hidden, true)
    await f.run({ name: 'task', args: ['unhide', 'work'] })
    assert.equal(f.state().cards[id]?.hidden, false)
    const events = readEvents({ board: 'default' })
    assert.equal(events.filter(e => e.type === 'task.visibility').length, 2)
    assert.deepEqual(replay({ state: emptyBoard(), events }), f.state())
    assert.match(JSON.stringify(await workerCommands.hydra(['check', '--after', '0'])), /task.brief|task.visibility/)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('descriptions and widths persist, resetting widths preserves the rest of the view', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'column', args: ['describe', 'needs_you', '--description', 'Questions only.'] })
    assert.equal(f.state().board?.columns[0]?.description, 'Questions only.')
    const seq = f.state().seq
    await f.run({ name: 'column', args: ['describe', 'needs_you', '--description', 'Questions only.'] })
    assert.equal(f.state().seq, seq)
    await f.run({ name: 'column', args: ['create', '--id', 'custom:review', '--title', 'Review', '--description', 'Results awaiting review.'] })
    await f.run({ name: 'view', args: ['set', '--json', '{"theme":"dark","fontSize":18}'] })
    await f.run({ name: 'column', args: ['resize', 'custom:review', '--width', '420'] })
    await f.run({ name: 'hydra', args: ['resize', '--width', '480'] })
    assert.equal(viewFor({ state: f.state() }).columnWidths['custom:review'], 420)
    assert.equal(viewFor({ state: f.state() }).hydraWidth, 480)
    const deletion = await f.run({ name: 'column', args: ['delete', 'custom:review'] })
    await f.run({ name: 'column', args: ['delete', 'custom:review', '--confirm', String(deletion.token)] })
    assert.throws(() => f.run({ name: 'column', args: ['resize', 'missing', '--width', '400'] }))
    assert.throws(() => f.run({ name: 'hydra', args: ['resize', '--width', '20'] }))
    await f.run({ name: 'layout', args: ['reset'] })
    const view = viewFor({ state: f.state() })
    assert.equal(view.hydraWidth, DEFAULT_WIDTHS.hydra)
    assert.deepEqual(view.columnWidths, {})
    assert.equal(view.theme, 'dark')
    assert.equal(view.fontSize, 18)
    assert.deepEqual(replay({ state: emptyBoard(), events: readEvents({ board: 'default' }) }), f.state())
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('moves and deletes confirm the exact action and reject a token after the target changes', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work'] })
    const args = ['work', 'done', '--actor', 'hydra', '--event-id', 'move-work']
    const first = await f.run({ name: 'move', args })
    const id = f.state().keys.work!
    assert.equal(first.confirmation, 'needed')
    assert.equal(f.state().cards[id]?.column, 'parked')
    await f.run({ name: 'task', args: ['rename', 'work', '--title', 'Changed task'] })
    const stale = await f.run({ name: 'move', args: [...args, '--confirm', String(first.token)] })
    assert.equal(stale.confirmation, 'needed')
    assert.notEqual(stale.token, first.token)
    await f.run({ name: 'move', args: [...args, '--confirm', String(stale.token)] })
    assert.equal(f.state().cards[id]?.column, 'done')
    const seq = f.state().seq
    await f.run({ name: 'move', args: [...args, '--confirm', String(stale.token)] })
    assert.equal(f.state().seq, seq)
    const deletion = await f.run({ name: 'column', args: ['delete', 'done', '--to', 'parked'] })
    assert.equal(deletion.confirmation, 'needed')
    const other = await f.run({ name: 'column', args: ['delete', 'done', '--to', 'needs_you', '--confirm', String(deletion.token)] })
    assert.equal(other.confirmation, 'needed')
    await f.run({ name: 'column', args: ['delete', 'done', '--to', 'parked', '--confirm', String(deletion.token)] })
    assert.equal(f.state().cards[id]?.column, 'parked')
    const reorder = await f.run({ name: 'column', args: ['reorder', 'parked', '--before', 'needs_you'] })
    assert.equal(reorder.confirmation, 'needed')
    await f.run({ name: 'column', args: ['reorder', 'parked', '--before', 'needs_you', '--confirm', String(reorder.token)] })
    assert.equal(f.state().board?.columns[0]?.id, 'parked')
    await f.run({ name: 'move', args: ['work', 'needs_you', '--actor', 'web'] })
    assert.equal(f.state().cards[id]?.column, 'needs_you')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('Hydra memory replaces by key, survives switching Hydra and isolates boards', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'hydra', args: ['memory', 'set', '--key', 'review-policy', '--text', 'Check the canary.'] })
    await f.run({ name: 'hydra', args: ['memory', 'set', '--key', 'review-policy', '--text', 'Check canary and rollback.'] })
    await f.run({ name: 'board', args: ['set', '--hydra', 'new-hydra'] })
    assert.equal(f.state().hydraMemory?.['review-policy']?.text, 'Check canary and rollback.')
    assert.match(JSON.stringify(await f.run({ name: 'hydra', board: 'other', args: ['memory'] })), /none: no Hydra memory/)
    assert.throws(() => f.run({ name: 'hydra', args: ['memory', 'set', '--key', '../escape', '--text', 'No.'] }))
    await f.run({ name: 'hydra', args: ['memory', 'forget', '--key', 'review-policy'] })
    assert.deepEqual(f.state().hydraMemory, {})
    assert.equal(readEvents({ board: 'default' }).filter(e => e.type === 'hydra.memory').length, 3)
    assert.deepEqual(replay({ state: emptyBoard(), events: readEvents({ board: 'default' }) }), f.state())
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('attaching hands the brief to the agent once and Firstmate start includes it', async () => {
  const f = fixture()

  try {
    const home = join(f.home, 'firstmate')
    cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), home, { recursive: true })
    await f.run({ name: 'board', args: ['set', '--firstmate', home] })
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work', '--brief', 'Verify the canary.'] })
    f.push({ key: 'work', input: { source: { adapter: 'firstmate', instanceId: home, objectId: 'api-v2' } } })
    f.push({ key: 'agent', input: { agent: { provider: 'claude-code', sessionId: 'worker' }, terminal: { tty: '/dev/ttys123' } } })
    const attach = ['attach', 'work', '--session', 'claude-code:worker', '--event-id', 'attach-worker']
    const sent = await f.run({ name: 'task', args: attach })
    assert.equal((sent.brief as Output).state, 'delivered')
    const log = readFileSync(join(home, 'sent.log'), 'utf8')
    assert.match(log, /Verify the canary/)
    await f.run({ name: 'task', args: attach })
    assert.equal(readFileSync(join(home, 'sent.log'), 'utf8'), log)
    await f.run({ name: 'task', args: ['detach', 'work'] })
    f.push({ key: 'replacement', input: { agent: { provider: 'claude-code', sessionId: 'replacement' }, terminal: { tty: '/dev/ttys124' } } })
    await f.run({ name: 'task', args: ['attach', 'work', '--session', 'claude-code:replacement'] })
    const replacementLog = readFileSync(join(home, 'sent.log'), 'utf8')
    const retry = await f.run({ name: 'task', args: attach })
    assert.equal((retry.brief as Output).state, 'failed')
    assert.equal(readFileSync(join(home, 'sent.log'), 'utf8'), replacementLog)
    await f.run({ name: 'task', args: ['detach', 'work'] })
    await startTask({ board: 'default', task: 'work', via: 'firstmate', meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })
    assert.match(readFileSync(join(home, 'inbox.json'), 'utf8'), /Verify the canary/)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('the board command receives the task brief before explicit opening instructions', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'board', args: ['set', '--command', 'node -e \'require("fs").writeFileSync("prompt.json", JSON.stringify(process.env.PNYX_PROMPT))\''] })
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work', '--folder', f.home, '--brief', 'Verify the canary.'] })
    await startTask({ board: 'default', task: 'work', via: 'command', prompt: 'Then report the result.', meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })
    const path = join(f.home, 'prompt.json')

    for (let i = 0; !existsSync(path) && i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    assert.equal(JSON.parse(readFileSync(path, 'utf8')), 'Verify the canary.\n\nThen report the result.')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})
