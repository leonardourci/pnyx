import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { HydraError, type HydraEvent } from '../src/core/model.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { hydraDir, hydraIds, loadHydra, repairHydra, withWriter } from '../src/store/hydra-store.ts'
import { STREAMS, assertGolden, readStream } from './streams.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(tmpdir(), 'pnyx-store-'))
})

const rejects = ({ fn, code }: { fn: () => unknown; code: string }) =>
  assert.throws(fn, (error: unknown) => error instanceof HydraError && error.code === code)

function appendAll({ events }: { events: HydraEvent[] }): void {
  withWriter({ hydraId: 'default', fn: ({ writer }) => events.forEach(e => writer.append({ event: e })) })
}

function seedLog({ stream }: { stream: string }): string {
  const dir = hydraDir({ hydraId: 'default' })
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(STREAMS, `${stream}.jsonl`), join(dir, 'events.jsonl'))

  return dir
}

test('appends are durable lines and the snapshot matches a full replay', () => {
  const events = readStream({ name: 'lifecycle' })
  appendAll({ events })
  const dir = hydraDir({ hydraId: 'default' })
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trimEnd()
    .split('\n')
  const written = lines.map(l => JSON.parse(l))
  assert.ok(written.every(e => e.boardId === 'default' && e.commandId === e.id))
  const original = written.map(({
    boardId, taskId, subtaskId, agentId,
    sessionId, commandId, ...e
  }) => {
    assert.ok(boardId && taskId && commandId)
    assert.ok(subtaskId === undefined || typeof subtaskId === 'string')
    assert.ok(agentId === undefined || typeof agentId === 'string')
    assert.ok(sessionId === undefined || typeof sessionId === 'string')

    return e
  })
  assert.deepEqual(original, events)
  const expected = replay({ state: emptyHydra(), events })
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state, expected)
  const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
  assert.deepEqual(snapshot.state, expected)
})

test('a missing, corrupt or stale snapshot is rebuilt from the log', () => {
  const events = readStream({ name: 'lifecycle' })
  appendAll({ events: events.slice(0, 4) })
  const dir = hydraDir({ hydraId: 'default' })
  const early = readFileSync(join(dir, 'snapshot.json'))
  appendAll({ events: events.slice(4) })
  const expected = replay({ state: emptyHydra(), events })

  // Crash between the append and the snapshot write: the old snapshot plus the log tail.
  writeFileSync(join(dir, 'snapshot.json'), early)
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state, expected)
  writeFileSync(join(dir, 'snapshot.json'), '{not json')
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state, expected)
  rmSync(join(dir, 'snapshot.json'))
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state, expected)
})

test('appends must continue the sequence', () => {
  appendAll({ events: readStream({ name: 'lifecycle' }).slice(0, 1) })
  const [, second] = readStream({ name: 'lifecycle' })
  assert.throws(() => appendAll({ events: [{ ...second!, seq: 5 }] }), /out of sequence/)
})

test('a torn tail is skipped on read, blocks writes and is set aside by repair', () => {
  const dir = seedLog({ stream: 'torn-tail' })
  const original = readFileSync(join(dir, 'events.jsonl'))
  const clean = original.subarray(0, original.lastIndexOf(10) + 1)

  const loaded = loadHydra({ hydraId: 'default' })
  assert.equal(loaded.state.seq, 3)
  assert.equal(loaded.tornBytes, original.length - clean.length)
  assertGolden({ name: 'torn-tail', actual: loaded.state })
  rejects({ fn: () => withWriter({ hydraId: 'default', fn: () => undefined }), code: 'TORN_TAIL' })

  const result = repairHydra({ hydraId: 'default' })
  assert.equal(result.tornBytes, loaded.tornBytes)
  assert.deepEqual(readFileSync(result.preserved!), original.subarray(clean.length))
  const repaired = readFileSync(join(dir, 'events.jsonl'))
  assert.deepEqual(repaired.subarray(0, original.length), original)
  const marker = JSON.parse(repaired.subarray(original.length + 1).toString('utf8'))
  assert.deepEqual(marker.data, { offset: clean.length, length: original.length - clean.length })
  assert.equal(loadHydra({ hydraId: 'default' }).tornBytes, 0)

  const [first] = readStream({ name: 'torn-tail' })
  appendAll({ events: [{ ...first!, seq: 4, id: 'evt_4', type: 'card.moved', data: { before: 'review', after: null } }] })
  assert.equal(loadHydra({ hydraId: 'default' }).state.cards.c1!.column, 'parked')
  rmSync(join(dir, 'snapshot.json'))
  assert.equal(loadHydra({ hydraId: 'default' }).state.seq, 4)
  assert.equal(repairHydra({ hydraId: 'default' }).tornBytes, 0)
})

test('repair skips a torn line even when it parses as an event', () => {
  const dir = seedLog({ stream: 'lifecycle' })
  const events = readStream({ name: 'lifecycle' })
  const unacknowledged = JSON.stringify({ ...events[0]!, seq: 9, id: 'evt_9', data: { key: 'ghost' } })
  writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl')).toString() + unacknowledged)
  repairHydra({ hydraId: 'default' })
  rmSync(join(dir, 'snapshot.json'))
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state, replay({ state: emptyHydra(), events }))
})

test('a repair marker that names the wrong line is corruption', () => {
  const dir = seedLog({ stream: 'lifecycle' })
  const marker = { v: 1, type: 'log.repaired', at: '2026-10-13T00:00:00Z', data: { offset: 0, length: 1 } }
  writeFileSync(join(dir, 'events.jsonl'), `${readFileSync(join(dir, 'events.jsonl'))}${JSON.stringify(marker)}\n`)
  rejects({ fn: () => loadHydra({ hydraId: 'default' }), code: 'LOG_CORRUPT' })
})

test('corruption inside the log is rejected, not skipped', () => {
  const dir = seedLog({ stream: 'lifecycle' })
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')
  lines[2] = '{garbage'
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'))
  rejects({ fn: () => loadHydra({ hydraId: 'default' }), code: 'LOG_CORRUPT' })
})

test('a lock left by a dead process is taken over', () => {
  const dir = hydraDir({ hydraId: 'default' })
  mkdirSync(dir, { recursive: true })
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(join(dir, 'writer.lock'), String(dead))
  appendAll({ events: readStream({ name: 'lifecycle' }).slice(0, 1) })
  assert.equal(existsSync(join(dir, 'writer.lock')), false)
})

test('Hydra names cannot escape the Hydras folder', () => {
  rejects({ fn: () => hydraDir({ hydraId: '../etc' }), code: 'VALIDATION_ERROR' })
  rejects({ fn: () => hydraDir({ hydraId: 'a/b' }), code: 'VALIDATION_ERROR' })
})

test('two writers racing to take over a dead lock never hold it together', async () => {
  const store = new URL('../src/store/hydra-store.ts', import.meta.url).href
  // Each contender holds the lock for a moment and fails loudly if it finds the other inside.
  const contender = `
    import { closeSync, openSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    import { createInterface } from 'node:readline'
    import { withWriter } from '${store}'
    process.stdout.write('ready\\n')
    await createInterface({ input: process.stdin })[Symbol.asyncIterator]().next()
    withWriter({ hydraId: 'default', fn: ({ writer }) => {
      const inside = join(writer.dir, 'inside')
      closeSync(openSync(inside, 'wx'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      rmSync(inside)
    } })
  `
  const dir = hydraDir({ hydraId: 'default' })
  mkdirSync(dir, { recursive: true })
  const dead = spawnSync(process.execPath, ['-e', '']).pid

  for (let round = 0; round < 40; round++) {
    writeFileSync(join(dir, 'writer.lock'), String(dead))
    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender])
      let stderr = ''
      child.stderr.on('data', chunk => (stderr += chunk))

      return { child, done: once(child, 'close').then(([code]) => ({ code, stderr })) }
    })
    await Promise.all(children.map(({ child, done }) => Promise.race([once(child.stdout, 'data'), done])))
    children.forEach(({ child }) => child.stdin.end('go\n'))
    const results = await Promise.all(children.map(({ done }) => done))
    assert.deepEqual(results, [{ code: 0, stderr: '' }, { code: 0, stderr: '' }], `round ${round}`)
    assert.equal(existsSync(join(dir, 'writer.lock')), false)
    assert.equal(existsSync(join(dir, 'writer.lock.takeover')), false)
  }
})

test('a Hydra in the old boards folder moves to hydras and its events replay', () => {
  const old = join(process.env.PNYX_HOME!, 'boards', 'existing')
  const dir = join(process.env.PNYX_HOME!, 'hydras', 'existing')
  mkdirSync(old, { recursive: true })
  const config = {
    id: 'existing',
    name: 'Existing work',
    hydra: { id: 'lead', kind: 'agent', name: 'Hydra' },
    columns: [{ id: 'parked', title: 'Later', role: 'parked' }],
  }
  const log = [
    { v: 1, seq: 1, id: 'configured', at: '2026-10-01T00:00:00Z', actor: 'cli', cardId: '$board', boardId: 'existing', type: 'board.configured', data: config },
    { v: 1, seq: 2, id: 'task', at: '2026-10-01T00:00:01Z', actor: 'cli', cardId: 't1', boardId: 'existing', type: 'task.created', data: { key: 'work', title: 'Keep this task' } },
    { v: 1, seq: 3, id: 'memory', at: '2026-10-01T00:00:02Z', actor: 'cli', cardId: '$board', boardId: 'existing', type: 'hydra.memory', data: { key: 'rule', before: null, after: 'Keep this fact' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(join(old, 'events.jsonl'), log)
  writeFileSync(join(old, 'snapshot.json'), JSON.stringify({
    v: 1,
    rules: 7,
    offset: Buffer.byteLength(log),
    state: { ...emptyHydra(), seq: 3, board: config, boardRevision: 1 },
  }))

  const loaded = loadHydra({ hydraId: 'existing' })
  assert.equal(loaded.dir, dir)
  assert.equal(existsSync(join(process.env.PNYX_HOME!, 'boards')), false)
  assert.equal(loaded.state.config?.name, 'Existing work')
  assert.equal(loaded.state.config?.hydra.id, 'lead')
  assert.equal(loaded.state.config?.columns[0]?.title, 'Later')
  assert.equal(loaded.state.configRevision, 1)
  assert.equal(loaded.state.cards.t1?.title, 'Keep this task')
  assert.equal(loaded.state.hydraMemory?.rule?.text, 'Keep this fact')
  repairHydra({ hydraId: 'existing' })
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), log)
  assert.deepEqual(loadHydra({ hydraId: 'existing' }).state, loaded.state)
})

const seed = ({ files }: { files: Record<string, string> }) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(process.env.PNYX_HOME!, name, '..'), { recursive: true })
    writeFileSync(join(process.env.PNYX_HOME!, name), text)
  }
}

test('a Hydra in both folders is refused and nothing moves', () => {
  seed({ files: { 'boards/default/events.jsonl': 'old\n', 'hydras/default/events.jsonl': 'new\n' } })

  rejects({ fn: () => hydraDir({ hydraId: 'default' }), code: 'CONFLICT' })
  assert.equal(readFileSync(join(process.env.PNYX_HOME!, 'boards/default/events.jsonl'), 'utf8'), 'old\n')
  assert.equal(readFileSync(join(process.env.PNYX_HOME!, 'hydras/default/events.jsonl'), 'utf8'), 'new\n')
})

test('hook spools left on either side of the move are folded in without overwriting', () => {
  seed({ files: { 'boards/default/events.jsonl': 'log\n', 'boards/default/spool/1.json': 'old', 'hydras/default/spool/2.json': 'new' } })
  seed({ files: { 'boards/other/spool/3.json': 'late', 'hydras/other/events.jsonl': 'log\n' } })

  const home = process.env.PNYX_HOME!
  assert.equal(hydraDir({ hydraId: 'default' }), join(home, 'hydras/default'))
  assert.equal(readFileSync(join(home, 'hydras/default/events.jsonl'), 'utf8'), 'log\n')
  assert.deepEqual(['1', '2'].map(n => readFileSync(join(home, `hydras/default/spool/${n}.json`), 'utf8')), ['old', 'new'])
  assert.equal(readFileSync(join(home, 'hydras/other/spool/3.json'), 'utf8'), 'late')
  assert.equal(existsSync(join(home, 'boards')), false)
})

test('a Hydra an older server still runs stays in boards until that server exits', () => {
  seed({ files: { 'boards/busy/events.jsonl': '', 'boards/busy/server.lock': JSON.stringify({ pid: process.ppid }), 'boards/idle/events.jsonl': '' } })

  const home = process.env.PNYX_HOME!
  assert.equal(hydraDir({ hydraId: 'busy' }), join(home, 'boards/busy'))
  assert.equal(hydraDir({ hydraId: 'idle' }), join(home, 'hydras/idle'))
  assert.deepEqual(hydraIds(), ['busy', 'idle'])

  rmSync(join(home, 'boards/busy/server.lock'))
  assert.equal(hydraDir({ hydraId: 'busy' }), join(home, 'hydras/busy'))
  assert.equal(existsSync(join(home, 'boards')), false)
})

test('processes starting together move each Hydra once', async () => {
  const home = process.env.PNYX_HOME!
  seed({ files: Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`boards/h${n}/events.jsonl`, `${n}\n`])) })
  const store = join(import.meta.dirname, '../src/store/hydra-store.ts')
  const runs = Array.from({ length: 6 }, () => new Promise<string>(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `const { hydraIds } = await import(${JSON.stringify(store)}); console.log(hydraIds().length)`], { env: process.env })
    let out = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (out += data))
    child.on('close', () => resolve(out.trim()))
  }))

  assert.deepEqual(await Promise.all(runs), Array(6).fill('100'))
  assert.equal(readFileSync(join(home, 'hydras/h42/events.jsonl'), 'utf8'), '42\n')
  assert.equal(existsSync(join(home, 'boards')), false)
})
