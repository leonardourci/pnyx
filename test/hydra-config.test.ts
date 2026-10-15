import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { hydraDir, spoolWrite } from '../src/store/hydra-store.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')

function hydraId() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-hydra-'))
  const env = { ...process.env, PNYX_HOME: home }

  const run = ({ args }: { args: string[] }): string => {
    const out = execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
    const token = /^token: ([a-f0-9]+)$/m.exec(out)?.[1]

    return token ? run({ args: [...args, '--confirm', token] }) : out
  }

  const fails = ({ args, status, code }: { args: string[]; status: number; code: string }) =>
    assert.throws(() => run({ args: [...args] }), (error: { status: number; stdout: string }) => {
      assert.equal(error.status, status)
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      return true
    })

  const card = ({ json }: { json: object }) => {
    const file = join(home, `card-${Math.random()}.json`)
    writeFileSync(file, JSON.stringify(json))

    return file
  }

  return { home, env, run, fails, card }
}

test('push is an idempotent upsert by key', () => {
  const { run, card } = hydraId()
  const file = card({ json: { title: 'Ship login', workspace: 'work', tags: ['auth'] } })
  assert.match(run({ args: ['push', '--key', 'claude:s1', '--file', file] }), /^ {2}id: c1$/m)
  assert.match(run({ args: ['push', '--key', 'claude:s1', '--file', file] }), /^event: "none: unchanged"$/m)
  assert.match(run({ args: ['push', '--key', 'claude:s1', '--file', card({ json: { title: 'x' } }), '--event-id', 'e1'] }), /^ {2}seq: 2$/m)
  const retry = run({ args: ['push', '--key', 'claude:s1', '--file', card({ json: { title: 'y' } }), '--event-id', 'e1'] })
  assert.match(retry, /^ {2}seq: 2$/m)
  assert.match(retry, /^duplicate: /m)
  const out = run({ args: [] })
  assert.match(out, /^ {2}in_progress: 1$/m)
  assert.match(out, /^ {2}c1,x,in_progress,none$/m)
})

test('only a move places the card; links, merges and outcomes leave it', () => {
  const { run, fails, card } = hydraId()
  run({ args: ['push', '--key', 'k', '--file', card({ json: { title: 'Task' } })] })
  run({ args: ['push', '--key', 'k2', '--file', card({ json: { title: 'Other' } })] })
  run({ args: ['link', 'c1', '--url', 'https://github.com/o/r/pull/7', '--state', 'open'] })
  assert.match(run({ args: ['card', 'k'] }), /^ {2}column: in_progress$/m)
  run({ args: ['move', 'c1', 'needs-you'] })
  run({ args: ['link', 'c1', '--url', 'https://github.com/o/r/pull/7', '--state', 'merged'] })
  run({ args: ['outcome', 'c1', 'done', '--note', 'shipped'] })
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}column: needs_you$/m)
  assert.match(run({ args: ['history', '--kind', 'outcome'] }), /done: shipped/)
  run({ args: ['move', 'c2', 'needs-you', '--before', 'c1'] })
  assert.match(run({ args: [] }), /^ {2}c2,Other,needs_you,none\n {2}c1,Task,needs_you,none$/m)
  fails({ args: ['move', 'c1', '--auto'], status: 2, code: 'VALIDATION_ERROR' })
})

test('history pages newest first and filters', () => {
  const { run, card } = hydraId()

  for (let i = 0; i < 5; i++) {
    run({ args: ['push', '--key', 'k', '--file', card({ json: { title: `t${i}` } })] })
  }

  const first = run({ args: ['history', '--limit', '2'] })
  assert.match(first, /^events\[2\]/m)
  assert.match(first, /^ {2}5,evt_5,/m)
  assert.match(first, /history --limit 2 --before 4/)
  const next = run({ args: ['history', '--limit', '2', '--before', '4'] })
  assert.match(next, /^ {2}3,evt_3,/m)
  assert.match(run({ args: ['history', '--kind', 'moved'] }), /^events: "none: no matching events"$/m)
})

test('undo appends a reversing event and refuses a second undo', () => {
  const { run, card } = hydraId()
  run({ args: ['push', '--key', 'k', '--file', card({ json: {} })] })
  run({ args: ['move', 'c1', 'done'] })
  assert.match(run({ args: ['undo', 'evt_2'] }), /^ {2}seq: 3$/m)
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}column: in_progress$/m)
  assert.match(run({ args: ['history', '--limit', '1'] }), /undo evt_2: done -> in_progress/)
})

test('every write takes --event-id and --if-revision', () => {
  const { run, fails, card } = hydraId()
  run({ args: ['push', '--key', 'k', '--file', card({ json: {} }), '--if-revision', '0'] })
  fails({ args: ['push', '--key', 'k', '--file', card({ json: { title: 'x' } }), '--if-revision', '0'], status: 1, code: 'REVISION_CONFLICT' })
  const url = 'https://github.com/o/r/pull/7'
  assert.match(run({ args: ['link', 'c1', '--url', url, '--state', 'open', '--event-id', 'l1', '--if-revision', '1'] }), /^ {2}revision: 2$/m)
  run({ args: ['outcome', 'c1', 'done', '--event-id', 'o1'] })
  const retry = run({ args: ['link', 'c1', '--url', url, '--state', 'open', '--event-id', 'l1', '--if-revision', '1'] })
  assert.match(retry, /^ {2}seq: 2$/m)
  assert.match(retry, /^ {2}revision: 2$/m)
  assert.match(retry, /^duplicate: /m)
  fails({ args: ['outcome', 'c1', 'failed', '--if-revision', '1'], status: 1, code: 'REVISION_CONFLICT' })
  fails({ args: ['move', 'c1', 'done', '--if-revision', '1'], status: 1, code: 'REVISION_CONFLICT' })
  fails({ args: ['undo', 'o1', '--if-revision', '1'], status: 1, code: 'REVISION_CONFLICT' })
})

test('undo reverses a manual push edit and refuses a merge', () => {
  const { run, fails, card } = hydraId()
  run({ args: ['push', '--key', 'k', '--file', card({ json: { title: 'Before' } })] })
  run({ args: ['push', '--key', 'k', '--file', card({ json: { title: 'After' } })] })
  run({ args: ['undo', 'evt_2'] })
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}title: Before$/m)
  fails({ args: ['undo', 'evt_1'], status: 1, code: 'NOT_UNDOABLE' })
  run({ args: ['link', 'c1', '--url', 'https://github.com/o/r/pull/7', '--state', 'merged'] })
  fails({ args: ['undo', 'evt_4'], status: 1, code: 'NOT_UNDOABLE' })
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}column: in_progress$/m)
})

test('errors are structured', () => {
  const { fails } = hydraId()
  fails({ args: ['card', 'c9'], status: 1, code: 'NOT_FOUND' })
  fails({ args: ['move', 'c1'], status: 2, code: 'VALIDATION_ERROR' })
  fails({ args: ['outcome', 'c1'], status: 2, code: 'VALIDATION_ERROR' })
  fails({ args: ['push', '--key', 'k'], status: 2, code: 'VALIDATION_ERROR' })
  fails({ args: ['history', '--bogus'], status: 2, code: 'VALIDATION_ERROR' })
  fails({ args: ['undo', 'evt_1'], status: 1, code: 'NOT_FOUND' })
})

test('a torn tail blocks writes until repair', () => {
  const { home, run, fails, card } = hydraId()
  run({ args: ['push', '--key', 'k', '--file', card({ json: { title: 'a' } })] })
  appendFileSync(join(home, 'boards', 'default', 'events.jsonl'), '{"v":1,"seq":2,"id":"ev')
  assert.match(run({ args: [] }), /torn tail/)
  fails({ args: ['move', 'c1', 'done'], status: 1, code: 'TORN_TAIL' })
  assert.match(run({ args: ['repair'] }), /set aside 23 torn bytes/)
  assert.match(run({ args: ['move', 'c1', 'done'] }), /^ {2}seq: 2$/m)
})

test('spooled hook events are ingested once, in order, by the next write', () => {
  const { env, run, card } = hydraId()
  process.env.PNYX_HOME = env.PNYX_HOME
  spoolWrite({ hydraId: 'default', entry: { id: 'hook-1', key: 'codex:t1', at: '2026-10-13T10:00:00Z', actor: 'hook', card: { title: 'From hook' } } })
  spoolWrite({ hydraId: 'default', entry: { id: 'hook-1', key: 'codex:t1', at: '2026-10-13T10:00:01Z', card: { title: 'Respooled' } } })
  const spool = join(hydraDir({ hydraId: 'default' }), 'spool')
  writeFileSync(join(spool, '999-bad.json'), '{nope')
  const out = run({ args: ['push', '--key', 'other', '--file', card({ json: {} })] })
  assert.match(out, /^ {2}ingested: 2$/m)
  assert.match(out, /^ {2}rejected: 1$/m)
  assert.match(run({ args: ['card', 'codex:t1'] }), /^ {2}title: From hook$/m)
  assert.deepEqual(readdirSync(spool), ['999-bad.json.rejected'])
  assert.match(run({ args: ['history'] }), /^events\[2\]/m)
})

test('a spooled hook push is an observation, so undo refuses it', () => {
  const { env, run, fails, card } = hydraId()
  process.env.PNYX_HOME = env.PNYX_HOME
  run({ args: ['push', '--key', 'codex:t1', '--file', card({ json: { title: 'Manual' } })] })
  spoolWrite({ hydraId: 'default', entry: { id: 'hook-7', key: 'codex:t1', at: '2026-10-13T10:00:00Z', card: { activity: 'idle' } } })
  run({ args: ['push', '--key', 'other', '--file', card({ json: {} })] })
  assert.match(run({ args: ['card', 'codex:t1'] }), /^ {2}activity: idle$/m)
  fails({ args: ['undo', 'hook-7'], status: 1, code: 'NOT_UNDOABLE' })
})

test('an event id reused for another card or type is an idempotency conflict', () => {
  const { run, fails, card } = hydraId()
  run({ args: ['push', '--key', 'a', '--file', card({ json: {} })] })
  run({ args: ['push', '--key', 'b', '--file', card({ json: {} }), '--event-id', 'x1'] })
  fails({ args: ['push', '--key', 'a', '--file', card({ json: { title: 't' } }), '--event-id', 'x1'], status: 1, code: 'IDEMPOTENCY_CONFLICT' })
  fails({ args: ['move', 'b', 'done', '--event-id', 'x1'], status: 1, code: 'IDEMPOTENCY_CONFLICT' })
  fails({ args: ['move', 'c1', 'done', '--event-id', 'evt_1'], status: 1, code: 'IDEMPOTENCY_CONFLICT' })
  assert.match(run({ args: ['push', '--key', 'b', '--file', card({ json: { title: 't' } }), '--event-id', 'x1'] }), /^duplicate: /m)
})

test('concurrent writers get one contiguous sequence', async () => {
  const { env, run, card } = hydraId()
  const exec = promisify(execFile)
  const file = card({ json: {} })
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => exec(process.execPath, [BIN, 'push', '--key', `k${i}`, '--file', file], { env })),
  )
  const log = readFileSync(join(env.PNYX_HOME, 'boards', 'default', 'events.jsonl'), 'utf8').trimEnd()
    .split('\n')
  assert.deepEqual(log.map(l => JSON.parse(l).seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.match(run({ args: [] }), /^ {2}in_progress: 8$/m)
  assert.equal(existsSync(join(env.PNYX_HOME, 'boards', 'default', 'writer.lock')), false)
})
