import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = join(import.meta.dirname, '../dist/cli/pnyx-axi.js')

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-task-cli-'))
  const dir = join(home, 'hydras/default')
  const env = { ...process.env, PNYX_HOME: home, PNYX_SEMANTIC: 'off' }
  const run = ({ args }: { args: string[] }) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })

  const push = ({ key, input }: { key: string; input: object }) => {
    const path = join(home, 'push.json')
    writeFileSync(path, JSON.stringify(input))

    return run({ args: ['push', '--key', key, '--file', path] })
  }

  let seq = 0

  const hook = ({ session, event, interactive = true }: {
    session: string
    event: string
    interactive?: boolean
  }) => {
    seq++
    const spool = join(dir, 'spool')
    mkdirSync(spool, { recursive: true })
    writeFileSync(join(spool, `${String(seq).padStart(4, '0')}.json`), JSON.stringify({
      id: `task-hook-${seq}`,
      at: `2026-10-14T12:00:${String(seq).padStart(2, '0')}Z`,
      harness: 'claude',
      event,
      ...(interactive ? { terminal: { tty: '/dev/ttys123', pid: '123' } } : {}),
      payload: { session_id: session, cwd: '/task-lab', prompt: `Work ${session}` },
    }))
    push({ key: 'probe', input: {} })
  }

  const state = () => JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')).state

  return { home, dir, run, push, hook, state }
}

test('attach pins one session, follows subsequent hooks, and preserves outcomes after moving', () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'work', '--title', 'A piece of work', '--folder', '/task-lab'] })
  f.hook({ session: 'a', event: 'SessionStart' })
  f.hook({ session: 'b', event: 'SessionStart' })
  const first = f.state()
  const task = first.keys.work
  assert.equal(first.cards[task].agent.sessionId, 'a')
  assert.equal(first.cards[first.keys['claude:b']].agent.sessionId, 'b')
  f.run({ args: ['task', 'create', '--key', 'other', '--title', 'Continue here'] })
  f.run({ args: ['task', 'attach', 'other', '--session', 'claude-code:a', '--event-id', 'move-a'] })
  const after = readFileSync(join(f.dir, 'events.jsonl'), 'utf8')
  f.run({ args: ['task', 'attach', 'other', '--session', 'claude-code:a', '--event-id', 'move-a', '--if-revision', '0'] })
  assert.equal(readFileSync(join(f.dir, 'events.jsonl'), 'utf8'), after)
  f.hook({ session: 'a', event: 'SessionEnd' })
  const ended = f.state()
  assert.equal(ended.cards[ended.keys.other].column, 'queued')
  f.run({ args: ['task', 'status', 'other', 'done', '--note', 'Work complete'] })
  assert.equal(f.state().cards[ended.keys.other].column, 'queued')
  assert.equal(ended.cards[task].agent, undefined)
  f.run({ args: ['task', 'detach', 'work'] })
  assert.equal(f.state().cards[ended.keys.other].agent.sessionId, 'a')
  f.run({ args: ['task', 'detach', 'other'] })
  f.hook({ session: 'a', event: 'UserPromptSubmit' })
  assert.equal(f.state().sessions['claude-code:a'].taskId, null)
  assert.equal(f.state().cards[f.state().keys['claude:a']].hidden, true)
  assert.match(f.run({ args: ['task', 'sessions'] }), /claude-code:a/)
})

test('background sessions remain in History and search while the live Hydra excludes them', () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'empty-task', '--title', 'Waiting task', '--folder', '/task-lab'] })
  f.hook({ session: 'background', event: 'SessionStart', interactive: false })
  const state = f.state()
  const id = state.keys['claude:background']
  assert.equal(state.cards[id].hidden, true)
  assert.equal(state.cards[state.keys['empty-task']].agent, undefined)
  assert.match(f.run({ args: ['card', id] }), /visibility: history/)
  assert.match(f.run({ args: ['history', '--card', id, '--full'] }), /background/)
  assert.doesNotMatch(f.run({ args: [] }), /task-lab/)
  assert.match(f.run({ args: ['oracle', 'task-lab'] }), new RegExp(id))
  f.hook({ session: 'background', event: 'UserPromptSubmit' })
  assert.equal(f.state().cards[id].hidden, true)
  f.hook({ session: 'background', event: 'SessionStart', interactive: false })
  assert.equal(f.state().cards[id].hidden, true)
})

test('project labels can be created, changed independently, cleared and searched', () => {
  const f = fixture()
  f.run({ args: ['task', 'create', '--key', 'labelled', '--title', 'Fix pagination', '--project', 'quartz-api'] })
  const id = f.state().keys.labelled
  assert.equal(f.state().cards[id].project, 'quartz-api')
  assert.match(f.run({ args: ['task', 'list'] }), /quartz-api/)
  assert.match(f.run({ args: ['oracle', 'quartz'] }), /Fix pagination/)
  f.run({ args: ['task', 'rename', id, '--project', 'web', '--title', 'Fix cursor'] })
  assert.equal(f.state().cards[id].title, 'Fix cursor')
  assert.equal(f.state().cards[id].project, 'web')
  f.run({ args: ['task', 'rename', id, '--project', 'cli'] })
  assert.equal(f.state().cards[id].title, 'Fix cursor')
  assert.equal(f.state().cards[id].project, 'cli')
  f.run({ args: ['task', 'rename', id, '--project', ''] })
  assert.equal(f.state().cards[id].project, undefined)
  assert.throws(() => f.run({ args: ['task', 'create', '--title', 'Invalid label', '--project', 'x'.repeat(101)] }))
  assert.throws(() => f.run({ args: ['task', 'rename', id, '--project', 'bad\nlabel'] }))
})

test('Done delay is a validated per-Hydra setting and CLI reads expire only Done cards', () => {
  const f = fixture()
  f.run({ args: ['hydra', 'create', 'default', '--done-after-hours', '0'] })
  f.run({ args: ['task', 'create', '--key', 'done', '--title', 'Retained result', '--column', 'done'] })
  f.run({ args: ['task', 'create', '--key', 'parked', '--title', 'Keep for later'] })
  assert.equal(f.state().config.doneAfterHours, 0)
  f.run({ args: ['hydra', 'set', '--done-after-hours', '48'] })
  assert.equal(f.state().config.doneAfterHours, 48)
  f.run({ args: ['hydra', 'create', 'other'] })
  assert.equal(f.state().config.doneAfterHours, 48)
  assert.throws(() => f.run({ args: ['hydra', 'set', '--done-after-hours', '-1'] }))
  assert.throws(() => f.run({ args: ['hydra', 'set', '--done-after-hours', 'NaN'] }))
  assert.throws(() => f.run({ args: ['hydra', 'set', '--done-after-hours', ''] }))
  f.run({ args: ['hydra', 'set', '--done-after-hours', '0.000000001'] })
  const listing = f.run({ args: ['task', 'list'] })
  assert.doesNotMatch(listing, /Retained result/)
  assert.match(listing, /Keep for later/)
  assert.equal(f.state().cards[f.state().keys.done].hidden, true)
  assert.match(f.run({ args: ['history', '--card', 'done'] }), /Task hidden/)
  assert.match(f.run({ args: ['oracle', 'Retained'] }), /Retained result/)
  f.run({ args: ['task', 'unhide', 'done'] })
  assert.match(f.run({ args: ['task', 'list'] }), /Retained result/)
})

test('new Hydra columns and tasks have UUIDs, role aliases work, and card hide overrides validate', () => {
  const f = fixture()
  f.run({ args: ['hydra', 'create', 'default', '--done-after-hours', '72'] })
  const columns = f.state().config.columns
  assert.equal(new Set(columns.map((c: { id: string }) => c.id)).size, 5)

  for (const column of columns) {
    assert.match(column.id, /^custom:[0-9a-f-]{36}$/)
  }

  f.run({ args: ['task', 'create', '--key', 'work', '--title', 'Work', '--event-id', 'create-once'] })
  const id = f.state().keys.work
  assert.match(id, /^task-[0-9a-f-]{36}$/)
  f.run({ args: ['task', 'create', '--key', 'work', '--title', 'Work', '--event-id', 'create-once'] })
  assert.equal(f.state().keys.work, id)
  f.run({ args: ['move', id, 'done', '--actor', 'web'] })
  assert.equal(f.state().cards[id].column, columns.find((c: { role?: string }) => c.role === 'done').id)
  f.run({ args: ['task', 'hide-after', id, '1', '--event-id', 'one-hour'] })
  f.run({ args: ['task', 'hide-after', id, '1', '--event-id', 'one-hour'] })
  assert.equal(f.state().cards[id].doneAfterHours, 1)
  f.run({ args: ['task', 'hide-after', id, '0'] })
  assert.equal(f.state().cards[id].doneAfterHours, 0)
  f.run({ args: ['task', 'hide-after', id, 'default'] })
  assert.equal(f.state().cards[id].doneAfterHours, undefined)
  assert.throws(() => f.run({ args: ['task', 'hide-after', id, '-1'] }))
  assert.throws(() => f.run({ args: ['task', 'hide-after', id, 'NaN'] }))
  assert.throws(() => f.run({ args: ['task', 'hide-after', id, ''] }))
})
