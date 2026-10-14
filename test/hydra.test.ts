import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BoardState, BoardEvent } from '../src/core/model.ts'
import { emptyBoard, replay } from '../src/core/reducer.ts'
import { liveTask } from '../src/core/tasks.ts'

const bin = join(import.meta.dirname, '../dist/cli/pnyx-axi.js')

function fixture({ board = 'default' }: { board?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-hydra-'))
  const env = { ...process.env, PNYX_HOME: root, PNYX_SEMANTIC: 'off' }
  const run = ({ args }: { args: string[] }) => execFileSync(process.execPath, [bin, ...args, '--board', board], { env, encoding: 'utf8' })
  const state = ({ id = board }: { id?: string } = {}): BoardState => JSON.parse(readFileSync(join(root, 'boards', id, 'snapshot.json'), 'utf8')).state
  const events = (): BoardEvent[] => readFileSync(join(root, 'boards', board, 'events.jsonl'), 'utf8').trim()
    .split('\n')
    .map(line => JSON.parse(line))

  const push = ({ key, input }: { key: string; input: object }) => {
    const path = join(root, 'input.json')
    writeFileSync(path, JSON.stringify(input))

    return run({ args: ['push', '--key', key, '--file', path] })
  }

  return { root, run, state, events, push }
}

test('boards keep one Hydra, independent task lists, and durable history after switching', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default', '--hydra', 'first'] })
    f.run({ args: ['task', 'create', '--key', 'work', '--title', 'Ship search'] })
    f.run({ args: ['hydra', 'send', '--task', 'work', '--action', 'worker', '--event-id', 'request-worker'] })
    const original = f.events().length
    f.run({ args: ['hydra', 'send', '--task', 'work', '--action', 'worker', '--event-id', 'request-worker'] })
    assert.equal(f.events().length, original)
    assert.throws(() => f.run({ args: ['hydra', 'send'] }))
    f.run({ args: ['hydra', 'send', '--text', 'What is left on the board?', '--event-id', 'board-question'] })
    const question = f.state().hydraMessages?.at(-1)
    assert.equal(question?.text, 'What is left on the board?')
    assert.equal(question?.task, undefined)
    assert.doesNotMatch(f.run({ args: ['task', 'history', 'work'] }), /What is left on the board/)
    f.run({ args: ['board', 'create', 'other', '--hydra', 'second'] })
    assert.equal(f.state({ id: 'other' }).board?.hydra.id, 'second')
    assert.equal(Object.values(f.state({ id: 'other' }).cards).filter(card => liveTask({ card })).length, 0)
    f.run({ args: ['board', 'set', '--hydra', 'replacement'] })
    assert.equal(f.state().board?.hydra.id, 'replacement')
    assert.equal(f.state().hydraMessages?.[0]?.hydra, 'first')
    assert.match(f.run({ args: ['task', 'history', 'work'] }), /request-worker|Create a worker/)
    assert.match(f.run({ args: ['board', 'list'] }), /default|other/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('declared status survives idle hooks, session end, replay, pins and column edits', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    f.run({ args: ['task', 'create', '--title', 'Root', '--key', 'root'] })
    f.run({ args: ['task', 'create', '--title', 'Child', '--key', 'child', '--parent', 'root'] })
    assert.throws(() => f.run({ args: ['task', 'create', '--title', 'Too deep', '--parent', 'child'] }))
    const root = f.state().keys.root!
    const child = f.state().keys.child!
    assert.equal(f.state().cards[root]?.column, 'parked')
    f.run({ args: ['task', 'status', 'root', 'working', '--note', 'Building it'] })
    f.push({ key: 'session', input: { agent: { provider: 'claude-code', sessionId: 'worker' }, terminal: { tty: '/dev/ttys123', pid: '123' }, source: { adapter: 'hooks', objectId: 'worker' } } })
    f.run({ args: ['task', 'attach', 'root', '--session', 'claude-code:worker'] })
    f.push({ key: 'root', input: { activity: 'idle', source: { adapter: 'hooks', objectId: 'worker' } } })
    assert.equal(f.state().cards[root]?.column, 'workers_on_it')
    f.run({ args: ['outcome', 'root', 'done'] })
    assert.equal(f.state().cards[root]?.column, 'done')
    f.run({ args: ['task', 'status', 'root', 'needs-you', '--note', 'Choose a schema'] })
    assert.equal(f.state().cards[root]?.column, 'needs_you')
    f.run({ args: ['column', 'rename', 'needs_you', '--title', 'Your turn'] })
    assert.equal(f.state().board?.columns[0]?.title, 'Your turn')
    f.run({ args: ['column', 'create', '--title', 'Research', '--id', 'custom:research'] })
    f.run({ args: ['column', 'reorder', 'custom:research', '--before', 'needs_you'] })
    assert.equal(f.state().board?.columns[0]?.id, 'custom:research')
    const reordered = f.events().length
    f.run({ args: ['column', 'reorder', 'custom:research', '--before', 'needs_you'] })
    assert.equal(f.events().length, reordered)
    f.run({ args: ['move', 'root', 'custom:research'] })
    f.run({ args: ['task', 'status', 'root', 'done', '--note', 'Finished'] })
    assert.equal(f.state().cards[root]?.column, 'custom:research')
    f.run({ args: ['column', 'delete', 'custom:research', '--to', 'parked'] })
    assert.equal(f.state().cards[root]?.column, 'parked')
    f.run({ args: ['undo', f.events().at(-1)!.id] })
    assert.equal(f.state().cards[root]?.manualColumn, 'custom:research')
    f.run({ args: ['column', 'delete', 'custom:research', '--to', 'parked'] })
    f.run({ args: ['move', 'root', '--auto'] })
    assert.equal(f.state().cards[root]?.column, 'done')
    f.run({ args: ['task', 'status', 'child', 'paused', '--note', 'Waiting for review'] })
    const history = f.events()
    assert.ok(history.every(e => e.boardId === 'default' && e.commandId))
    assert.ok(history.some(e => e.subtaskId === child && e.taskId === root))
    const before = structuredClone(history)
    const replayed = replay({ state: emptyBoard(), events: history })
    assert.deepEqual(JSON.parse(JSON.stringify(replayed)), f.state())
    assert.deepEqual(history, before)
    assert.match(f.run({ args: ['task', 'history', 'root', '--limit', '100'] }), /Waiting for review|Choose a schema|claude-code:worker/)
    assert.match(f.run({ args: ['search', 'schema'] }), /root|Choose a \[schema\]/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('ad-hoc sessions never become tasks, and a confirmed merge completes declared work', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    f.push({ key: 'ad-hoc', input: { title: 'Unassigned interactive session', agent: { provider: 'codex', sessionId: 's' }, terminal: { tty: '/dev/ttys123' } } })
    assert.equal(Object.values(f.state().cards).filter(card => liveTask({ card })).length, 0)
    f.run({ args: ['board', 'set', '--hydra', 'codex:s', '--session', 'codex:s'] })
    f.run({ args: ['task', 'create', '--key', 'work', '--title', 'Work'] })
    assert.throws(() => f.run({ args: ['task', 'attach', 'work', '--session', 'codex:s'] }))
    f.run({ args: ['link', 'work', '--url', 'https://github.com/example/app/pull/1', '--state', 'merged'] })
    const work = f.state().keys.work!
    assert.equal(f.state().cards[work]?.column, 'done')

    for (const id of ['needs_you', 'workers_on_it', 'done']) {
      f.run({ args: ['column', 'delete', id] })
    }

    assert.throws(() => f.run({ args: ['column', 'delete', 'parked'] }))
    assert.equal(f.state().board?.columns.length, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('Firstmate mirror includes backlog-only tasks, complete status and metadata across a Hydra switch', () => {
  const f = fixture()

  try {
    const home = join(f.root, 'firstmate')
    cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), home, { recursive: true })
    f.run({ args: ['firstmate', 'sync', '--home', home] })
    const task = Object.values(f.state().cards).find(c => c.mirror?.task === 'api-v2')!
    assert.match(task.mirror!.status, /working|needs-decision/)
    assert.ok(task.mirror!.meta.worktree)
    assert.ok(Object.values(f.state().cards).some(c => c.mirror?.task === 'later-1'))
    const first = f.events().length
    f.run({ args: ['firstmate', 'sync', '--home', home] })
    assert.equal(f.events().length, first)
    appendFileSync(join(home, 'state/api-v2.status'), 'paused [at=1792000000]: Waiting for release\n')
    f.run({ args: ['firstmate', 'sync', '--home', home] })
    assert.match(f.run({ args: ['task', 'history', task.id, '--limit', '100'] }), /Waiting for release/)
    rmSync(join(home, 'state/api-v2.status'))
    rmSync(join(home, 'state/api-v2.meta'))
    f.run({ args: ['firstmate', 'sync', '--home', home] })
    assert.match(f.state().cards[task.id]!.mirror!.status, /Waiting for release/)
    assert.ok(f.state().cards[task.id]!.mirror!.meta.worktree)
    assert.deepEqual(f.state().cards[task.id]!.mirror!.present, { meta: false, status: false })
    f.run({ args: ['board', 'set', '--hydra', 'next-agent'] })
    appendFileSync(join(home, 'state/api-v2.status'), 'working: changed after switch\n')
    f.run({ args: ['firstmate', 'sync', '--home', home] })
    assert.doesNotMatch(f.state().cards[task.id]!.mirror!.status, /changed after switch/)
    assert.match(f.state().cards[task.id]!.mirror!.status, /Waiting for release/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('task messages remain in history and chat after the worker transcript is removed', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    f.run({ args: ['task', 'create', '--title', 'Keep the context', '--key', 'context'] })
    const transcript = join(f.root, 'worker.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:00:00Z', message: { content: 'The rollout stopped at the canary gate. Key sk-live0123456789abcdefXYZ' } })}\n`)
    f.push({ key: 'worker', input: { agent: { provider: 'claude-code', sessionId: 'context-worker', transcriptPath: transcript }, terminal: { tty: '/dev/ttys123', pid: '123' } } })
    f.run({ args: ['task', 'attach', 'context', '--session', 'claude-code:context-worker', '--event-id', 'attach-worker'] })
    const saved = f.events().filter(e => e.type === 'chat.message')
    assert.equal(saved.length, 1)
    assert.ok(saved[0]?.messageId && saved[0]?.sessionId)
    assert.doesNotMatch(readFileSync(join(f.root, 'boards', 'default', 'events.jsonl'), 'utf8'), /sk-live0123456789abcdefXYZ/)
    assert.match(JSON.stringify(saved[0]?.data), /canary gate\. Key \[redacted\]/)
    f.run({ args: ['harvest'] })
    assert.equal(f.events().filter(e => e.type === 'chat.message').length, 1)
    rmSync(transcript)
    assert.match(f.run({ args: ['task', 'chat', 'context'] }), /rollout stopped at the canary gate/)
    assert.match(f.run({ args: ['task', 'history', 'context'] }), /chat.message|canary gate/)
    f.run({ args: ['task', 'detach', 'context'] })
    assert.match(f.run({ args: ['task', 'chat', 'context', '--session', 'claude-code:context-worker'] }), /canary gate/)
    f.run({ args: ['search', 'rebuild'] })
    assert.match(f.run({ args: ['search', 'canary', '--kind', 'transcript'] }), /canary/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('role columns record a declaration, custom columns pin, column edits keep the board unconfigured and outcome undo restores status', () => {
  const f = fixture({ board: 'work' })

  try {
    f.run({ args: ['column', 'rename', 'needs_you', '--title', 'Your turn'] })
    assert.equal(f.state().board?.id, 'work')
    assert.equal(f.state().configured, undefined)
    f.run({ args: ['board', 'create', 'work'] })
    assert.equal(f.state().board?.columns[0]?.title, 'Your turn')
    f.run({ args: ['task', 'create', '--title', 'Ask', '--key', 'ask', '--column', 'needs_you'] })
    const ask = f.state().keys.ask!
    assert.equal(f.state().cards[ask]?.manualColumn, undefined)
    assert.equal(f.state().cards[ask]?.status?.state, 'needs_you')
    f.run({ args: ['task', 'status', 'ask', 'working', '--note', 'On it'] })
    assert.equal(f.state().cards[ask]?.column, 'workers_on_it')
    f.run({ args: ['outcome', 'ask', 'done'] })
    assert.equal(f.state().cards[ask]?.column, 'done')
    f.run({ args: ['undo', f.events().at(-1)!.id] })
    assert.equal(f.state().cards[ask]?.status?.state, 'working')
    assert.equal(f.state().cards[ask]?.column, 'workers_on_it')
    f.run({ args: ['column', 'create', '--title', 'Later', '--id', 'custom:later'] })
    f.run({ args: ['task', 'create', '--title', 'Someday', '--key', 'someday', '--column', 'custom:later'] })
    assert.equal(f.state().cards[f.state().keys.someday!]?.manualColumn, 'custom:later')
    f.push({ key: 'pushed', input: { title: 'Pushed', activity: 'waiting' } })
    f.run({ args: ['link', 'pushed', '--url', 'https://github.com/example/app/pull/2', '--state', 'open'] })
    const pushed = f.state().cards[f.state().keys.pushed!]!
    assert.equal(pushed.tracking, 'declared')
    assert.ok(f.state().board?.columns.some(c => c.id === pushed.column))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a session moved between tasks keeps each retained message once', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    f.run({ args: ['task', 'create', '--title', 'First home', '--key', 'first'] })
    f.run({ args: ['task', 'create', '--title', 'Second home', '--key', 'second'] })
    const transcript = join(f.root, 'mover.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:00:00Z', message: { content: 'The migration paused at the backfill step.' } })}\n`)
    const lonely = join(f.root, 'lonely.jsonl')
    writeFileSync(lonely, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:00:00Z', message: { content: 'An unattached backfill note.' } })}\n`)
    f.push({ key: 'lonely', input: { agent: { provider: 'claude-code', sessionId: 'lonely', transcriptPath: lonely }, terminal: { tty: '/dev/ttys127', pid: '127' } } })
    f.push({ key: 'mover', input: { agent: { provider: 'claude-code', sessionId: 'mover', transcriptPath: transcript }, terminal: { tty: '/dev/ttys124', pid: '124' } } })

    const once = () => {
      const found = f.run({ args: ['search', 'backfill', '--kind', 'transcript'] })
      assert.equal(found.split('[backfill] step').length - 1, 1, found)
      assert.match(found, /unattached \[backfill\] note/)
    }

    f.run({ args: ['search', 'rebuild'] })
    f.run({ args: ['task', 'attach', 'first', '--session', 'claude-code:mover'] })
    once()
    f.run({ args: ['search', 'rebuild'] })
    once()
    f.run({ args: ['task', 'detach', 'first'] })
    f.run({ args: ['task', 'attach', 'second', '--session', 'claude-code:mover'] })
    assert.equal(f.events().filter(e => e.type === 'chat.message').length, 1)
    once()
    f.run({ args: ['search', 'rebuild'] })
    once()
    rmSync(transcript)
    assert.equal(f.run({ args: ['task', 'chat', 'second'] }).split('backfill step').length - 1, 1)
    assert.match(f.run({ args: ['task', 'chat', 'first', '--session', 'claude-code:mover'] }), /backfill step/)
    f.run({ args: ['search', 'rebuild'] })
    once()
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('detach after new transcript settings, strict column ids and compact task outputs', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    assert.match(f.run({ args: ['task', 'list'] }), /none: no tasks on this board/)
    assert.match(f.run({ args: ['hydra', 'messages'] }), /none: no messages after seq 0/)
    f.run({ args: ['task', 'create', '--title', 'Ship it', '--key', 'ship'] })
    const transcript = join(f.root, 'detach.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:00:00Z', message: { model: 'claude-opus-5-5', content: 'Starting.' } })}\n`)
    f.push({ key: 'detacher', input: { agent: { provider: 'claude-code', sessionId: 'detacher', transcriptPath: transcript }, terminal: { tty: '/dev/ttys125', pid: '125' } } })
    f.run({ args: ['task', 'attach', 'ship', '--session', 'claude-code:detacher'] })
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:01:00Z', message: { model: 'claude-sonnet-5-5', content: 'Switched model.' } })}\n`)
    const ship = f.state().keys.ship!
    const revision = f.state().cards[ship]!.revision
    f.run({ args: ['task', 'detach', 'ship', '--if-revision', String(revision)] })
    assert.equal(f.state().cards[ship]?.sessionIds?.length, 0)
    const harvested = f.events().filter(e => e.actor === 'harvest' && e.cardId === ship)
    assert.ok(harvested.some(e => e.type === 'card.pushed' && e.seq > f.events().find(x => x.type === 'task.session' && x.data.after === ship)!.seq))
    assert.throws(() => f.run({ args: ['task', 'status', 'ship', 'working', '--if-revision', String(revision)] }))

    assert.throws(() => f.run({ args: ['move', 'ship', 'review'] }))
    assert.throws(() => f.run({ args: ['column', 'create', '--title', 'Mixed', '--id', 'custom:Review2'] }))
    f.run({ args: ['column', 'create', '--title', 'Upper', '--event-id', 'Upper-Column'] })
    f.run({ args: ['move', 'ship', 'custom:upper-column'] })
    assert.equal(f.state().cards[ship]?.column, 'custom:upper-column')

    f.run({ args: ['task', 'status', 'ship', 'working', '--note', 'Rolling out'] })
    const compact = f.run({ args: ['task', 'show', 'ship'] })
    assert.match(compact, /status: "?working: Rolling out"?/)
    assert.doesNotMatch(compact, /statusLog/)
    assert.match(f.run({ args: ['task', 'show', 'ship', '--full'] }), /statusLog/)
    const history = f.run({ args: ['task', 'history', 'ship'] })
    assert.match(history, /claude-code:detacher/)
    assert.doesNotMatch(history, /data:/)
    assert.match(f.run({ args: ['task', 'history', 'ship', '--full'] }), /data/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('board folders and the files holding copied chat stay private to the owner', () => {
  const f = fixture()

  try {
    const dir = join(f.root, 'boards', 'default')
    const mode = ({ path }: { path: string }) => statSync(path).mode & 0o777
    f.run({ args: ['board', 'create', 'default'] })
    assert.equal(mode({ path: dir }), 0o700)
    assert.equal(mode({ path: join(dir, 'events.jsonl') }), 0o600)
    assert.equal(mode({ path: join(dir, 'snapshot.json') }), 0o600)
    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'events.jsonl'), 0o644)
    chmodSync(join(dir, 'snapshot.json'), 0o644)
    f.run({ args: ['task', 'create', '--title', 'Private'] })
    assert.equal(mode({ path: dir }), 0o700)
    assert.equal(mode({ path: join(dir, 'events.jsonl') }), 0o600)
    assert.equal(mode({ path: join(dir, 'snapshot.json') }), 0o600)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('search keeps one copy of each archived native line, long or repeated', () => {
  const f = fixture()

  try {
    f.run({ args: ['board', 'create', 'default'] })
    f.run({ args: ['task', 'create', '--title', 'Long task', '--key', 'long'] })
    const transcript = join(f.root, 'long.jsonl')
    const line = ({ text }: { text: string }) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T19:00:00Z', message: { content: text } })}\n`
    writeFileSync(transcript, line({ text: `${'Padding words about the rollout. '.repeat(40)}The zebrafinch flag closed the loop.` }) + line({ text: 'Please verify the koala gate.' }))
    f.push({ key: 'long-session', input: { agent: { provider: 'claude-code', sessionId: 'long', transcriptPath: transcript }, terminal: { tty: '/dev/ttys128', pid: '128' } } })
    const hits = ({ word }: { word: string }) => Number(/results\[(\d+)\]/.exec(f.run({ args: ['search', word, '--kind', 'transcript'] }))?.[1] ?? 0)
    f.run({ args: ['search', 'rebuild'] })
    f.run({ args: ['task', 'attach', 'long', '--session', 'claude-code:long'] })
    assert.ok(f.events().filter(e => e.type === 'chat.message').length > 2)
    assert.equal(hits({ word: 'zebrafinch' }), 1)
    f.run({ args: ['search', 'rebuild'] })
    assert.equal(hits({ word: 'zebrafinch' }), 1)
    assert.equal(hits({ word: 'koala' }), 1)
    f.run({ args: ['task', 'detach', 'long'] })
    appendFileSync(transcript, line({ text: 'Please verify the koala gate.' }))
    assert.equal(hits({ word: 'koala' }), 2)
    f.run({ args: ['search', 'rebuild'] })
    assert.equal(hits({ word: 'koala' }), 2)
    rmSync(transcript)
    f.run({ args: ['search', 'rebuild'] })
    assert.equal(hits({ word: 'zebrafinch' }), 1)
    assert.equal(hits({ word: 'koala' }), 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('saving view preferences preserves pins owned by board columns', () => {
  const f = fixture()

  try {
    f.run({ args: ['column', 'create', '--id', 'custom:research', '--title', 'Research'] })
    f.run({ args: ['task', 'create', '--key', 'research', '--title', 'Check context', '--column', 'custom:research'] })
    const id = f.state().keys.research!
    const before = f.state().cards[id]!
    assert.equal(before.manualColumn, 'custom:research')

    for (const patch of [{ fontSize: 16 }, { theme: 'light' }, { columnWidths: { 'custom:research': 400 } }]) {
      f.run({ args: ['view', 'set', '--json', JSON.stringify(patch)] })
      const current = f.state().cards[id]!
      assert.equal(current.manualColumn, 'custom:research')
      assert.equal(current.column, 'custom:research')
      assert.equal(current.revision, before.revision)
    }

    f.run({ args: ['view', 'set', '--json', JSON.stringify({ customColumns: [] })] })
    assert.equal(f.state().view?.columnWidths['custom:research'], 400)
    assert.equal(f.state().cards[id]!.manualColumn, 'custom:research')
    const replayed = replay({ state: emptyBoard(), events: f.events() })
    assert.deepEqual(replayed.cards[id], f.state().cards[id])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
