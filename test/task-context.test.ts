import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands, type Output } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { hydraCheck, workerCommands } from '../src/cli/workers.ts'
import { decidePush } from '../src/core/decide.ts'
import { DEFAULT_WIDTHS, viewFor } from '../src/core/view.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-context-')))
  process.env.PNYX_HOME = home
  const run = ({ name, args = [], hydraId = 'default' }: { name: keyof typeof commands; args?: string[]; hydraId?: string }): Output | Promise<Output> => commands[name]([...args, '--hydra', hydraId])
  const state = () => loadHydra({ hydraId: 'default' }).state
  const push = ({ key, input }: { key: string; input: object }) => withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const d = decidePush({ state: writer.state, newCardId: `c${writer.state.seq + 1}`, key, input, meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })

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
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work', '--brief', 'Check the canary.', '--column', 'in_progress'] })
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
    assert.equal(f.state().cards[id]?.column, 'in_progress')
    assert.equal(f.state().cards[id]?.hidden, true)
    await f.run({ name: 'task', args: ['unhide', 'work'] })
    assert.equal(f.state().cards[id]?.hidden, false)
    const events = readEvents({ hydraId: 'default' })
    assert.equal(events.filter(e => e.type === 'task.visibility').length, 2)
    assert.deepEqual(replay({ state: emptyHydra(), events }), f.state())
    assert.match(JSON.stringify(await workerCommands.hydra(['check', '--after', '0'])), /task.brief|task.visibility/)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('descriptions and widths persist, resetting widths preserves the rest of the view', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'column', args: ['describe', 'needs_you', '--description', 'Questions only.'] })
    assert.equal(f.state().config?.columns.find(c => c.id === 'needs_you')?.description, 'Questions only.')
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
    assert.deepEqual(replay({ state: emptyHydra(), events: readEvents({ hydraId: 'default' }) }), f.state())
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('moves and deletes confirm the exact action and reject a token after the target changes', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work'] })
    const args = ['work', 'done', '--actor', 'hydra', '--reason', 'The worker finished', '--event-id', 'move-work']
    const first = await f.run({ name: 'move', args })
    const id = f.state().keys.work!
    assert.equal(first.confirmation, 'needed')
    assert.equal(f.state().cards[id]?.column, 'queued')
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
    const reorder = await f.run({ name: 'column', args: ['reorder', 'parked', '--before', 'queued'] })
    assert.equal(reorder.confirmation, 'needed')
    await f.run({ name: 'column', args: ['reorder', 'parked', '--before', 'queued', '--confirm', String(reorder.token)] })
    assert.equal(f.state().config?.columns[0]?.id, 'parked')
    await f.run({ name: 'move', args: ['work', 'needs_you', '--actor', 'web'] })
    assert.equal(f.state().cards[id]?.column, 'needs_you')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('Hydra changes need one reason, which Pnyx posts as its chat line, and the owner needs none', async () => {
  const f = fixture()

  try {
    const hydra = ['--actor', 'hydra']
    await assert.rejects(async () => f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'API cleanup', ...hydra] }), { code: 'VALIDATION_ERROR' })
    const created = await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'API cleanup', ...hydra, '--reason', 'the owner asked for it'] })
    assert.equal(created.posted, 'Created API cleanup: the owner asked for it')
    await assert.rejects(async () => f.run({ name: 'task', args: ['brief', 'work', '--brief', 'Check it.', ...hydra, '--reason', ' '] }), /--reason/)
    await assert.rejects(async () => f.run({ name: 'task', args: ['hide', 'work', ...hydra] }), /--reason/)
    await assert.rejects(async () => f.run({ name: 'move', args: ['work', 'needs_you', ...hydra] }), /--reason/)
    await assert.rejects(async () => f.run({ name: 'task', args: ['start', 'work', '--via', 'command', ...hydra] }), /--reason/)
    const why = ['--reason', 'its agent asked which schema to use', '--details', 'It found two schemas: v1 in the API and v2 in the migration.']
    const asked = await f.run({ name: 'move', args: ['work', 'needs_you', ...hydra, ...why] })
    assert.equal(asked.posted, undefined)
    const moved = await f.run({ name: 'move', args: ['work', 'needs_you', ...hydra, ...why, '--event-id', 'move-1', '--confirm', String(asked.token)] })
    assert.equal(moved.posted, 'Moved API cleanup to Needs you: its agent asked which schema to use')
    const seq = f.state().seq
    await f.run({ name: 'move', args: ['work', 'needs_you', ...hydra, ...why, '--event-id', 'move-1', '--confirm', String(asked.token)] })
    assert.equal(f.state().seq, seq)
    await f.run({ name: 'move', args: ['work', 'done', '--actor', 'web'] })
    await f.run({ name: 'task', args: ['brief', 'work', '--brief', 'Owner edit.'] })
    const summaries = (await f.run({ name: 'task', args: ['history', 'work'] }) as { events: { summary: string }[] }).events.map(e => e.summary)
    assert.deepEqual(summaries, [
      'Task brief updated',
      'needs_you -> done',
      'Hydra: Moved API cleanup to Needs you: its agent asked which schema to use (It found two schemas: v1 in the API and v2 in the migration.)',
      'queued -> needs_you (why: its agent asked which schema to use)',
      'Hydra: Created API cleanup: the owner asked for it',
      'Created task: API cleanup (why: the owner asked for it)',
    ])

    // A fresh Hydra session starts from cursor 0 and rereads its own lines with their reasons.
    const lines = ['Created API cleanup: the owner asked for it', 'Moved API cleanup to Needs you: its agent asked which schema to use']
    const messages = await f.run({ name: 'hydra', args: ['messages', '--after', '0'] }) as { messages: { actor: string; text: string }[] }
    assert.deepEqual(messages.messages.map(m => [m.actor, m.text]), lines.map(text => ['hydra', text]))
    const check = await hydraCheck({ args: ['check', '--after', '0', '--hydra', 'default'] }) as { changes: { type: string; actor: string; summary: string }[] }
    const own = check.changes.filter(c => c.type === 'hydra.message').map(c => c.summary)
    assert.deepEqual(own, [`Hydra: ${lines[0]}`, `Hydra: ${lines[1]} (It found two schemas: v1 in the API and v2 in the migration.)`])
    assert.ok(check.changes.some(c => c.actor === 'web'))
    assert.ok(!check.changes.some(c => c.actor === 'hydra' && c.type !== 'hydra.message'))
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('Hydra lines name starts, undos and returns, and the receipt carries the current revision', async () => {
  const f = fixture()

  try {
    const hydra = ['--actor', 'hydra']
    await f.run({ name: 'hydra', args: ['set', '--command', 'true'] })
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Docs', '--folder', f.home] })
    const id = f.state().keys.work!
    const started = await f.run({ name: 'task', args: ['start', 'work', '--via', 'command', ...hydra, '--reason', 'the brief is ready'] })
    assert.equal(started.posted, 'Started a worker on Docs: the brief is ready')
    const hidden = await f.run({ name: 'task', args: ['hide', 'work', ...hydra, '--reason', 'the owner paused it'] }) as { card: { revision: number } }
    assert.equal(hidden.card.revision, f.state().cards[id]!.revision)
    const shown = await f.run({ name: 'task', args: ['unhide', 'work', ...hydra, '--reason', 'the owner resumed it', '--details', 'Resume after the release.'] })
    assert.equal(shown.posted, 'Returned Docs to the Hydra: the owner resumed it')
    const moved = await f.run({ name: 'move', args: ['work', 'done', '--actor', 'web'] }) as { event: { id: string } }
    const undone = await f.run({ name: 'undo', args: [moved.event.id, ...hydra, '--reason', 'the work is not finished'] })
    assert.equal(undone.posted, 'Moved Docs back to Queued: the work is not finished')
    const rows = (await f.run({ name: 'hydra', args: ['messages', '--after', '0'] }) as { messages: { text: string; details?: string }[] }).messages
    assert.deepEqual(rows.find(r => r.details), { ...rows.find(r => r.details), text: 'Returned Docs to the Hydra: the owner resumed it', details: 'Resume after the release.' })
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('Hydra memory replaces by key, survives switching Hydra and isolates Hydras', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'hydra', args: ['memory', 'set', '--key', 'review-policy', '--text', 'Check the canary.'] })
    await f.run({ name: 'hydra', args: ['memory', 'set', '--key', 'review-policy', '--text', 'Check canary and rollback.'] })
    await f.run({ name: 'hydra', args: ['set', '--identity', 'new-hydra'] })
    assert.equal(f.state().hydraMemory?.['review-policy']?.text, 'Check canary and rollback.')
    assert.match(JSON.stringify(await f.run({ name: 'hydra', hydraId: 'other', args: ['memory'] })), /none: no Hydra memory/)
    assert.throws(() => f.run({ name: 'hydra', args: ['memory', 'set', '--key', '../escape', '--text', 'No.'] }))
    await f.run({ name: 'hydra', args: ['memory', 'forget', '--key', 'review-policy'] })
    assert.deepEqual(f.state().hydraMemory, {})
    assert.equal(readEvents({ hydraId: 'default' }).filter(e => e.type === 'hydra.memory').length, 3)
    assert.deepEqual(replay({ state: emptyHydra(), events: readEvents({ hydraId: 'default' }) }), f.state())
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('attaching hands the brief to the agent once and Firstmate start includes it', async () => {
  const f = fixture()

  try {
    const home = join(f.home, 'firstmate')
    cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), home, { recursive: true })
    await f.run({ name: 'hydra', args: ['set', '--firstmate', home] })
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
    await startTask({ hydraId: 'default', task: 'work', via: 'firstmate', meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })
    assert.match(readFileSync(join(home, 'inbox.json'), 'utf8'), /Verify the canary/)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('the Hydra command receives the task brief before explicit opening instructions', async () => {
  const f = fixture()

  try {
    await f.run({ name: 'hydra', args: ['set', '--command', 'node -e \'require("fs").writeFileSync("prompt.json", JSON.stringify(process.env.PNYX_PROMPT))\''] })
    await f.run({ name: 'task', args: ['create', '--key', 'work', '--title', 'Work', '--folder', f.home, '--brief', 'Verify the canary.'] })
    await startTask({ hydraId: 'default', task: 'work', via: 'command', prompt: 'Then report the result.', meta: { at: '2026-10-15T12:00:00Z', actor: 'test' } })
    const path = join(f.home, 'prompt.json')

    for (let i = 0; !existsSync(path) && i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    assert.equal(JSON.parse(readFileSync(path, 'utf8')), 'Verify the canary.\n\nThen report the result.')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})
