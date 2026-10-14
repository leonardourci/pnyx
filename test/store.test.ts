import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { BoardError, type BoardEvent } from '../src/core/model.ts'
import { emptyBoard, replay } from '../src/core/reducer.ts'
import { boardDir, loadBoard, repairBoard, withWriter } from '../src/store/board-store.ts'
import { STREAMS, assertGolden, readStream } from './streams.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

beforeEach(() => {
  // Every test gets its own home; nothing touches the real ~/.pnyx.
  process.env.PNYX_HOME = mkdtempSync(join(tmpdir(), 'pnyx-store-'))
})

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => error instanceof BoardError && error.code === code)

function appendAll(events: BoardEvent[]): void {
  withWriter({ board: 'default', fn: ({ writer }) => events.forEach(e => writer.append({ event: e })) })
}

function seedLog(stream: string): string {
  const dir = boardDir({ board: 'default' })
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(STREAMS, `${stream}.jsonl`), join(dir, 'events.jsonl'))

  return dir
}

test('appends are durable lines and the snapshot matches a full replay', () => {
  const events = readStream('lifecycle')
  appendAll(events)
  const dir = boardDir({ board: 'default' })
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trimEnd()
    .split('\n')
  assert.deepEqual(lines.map(l => JSON.parse(l)), events)
  const expected = replay({ state: emptyBoard(), events })
  assert.deepEqual(loadBoard({ board: 'default' }).state, expected)
  const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
  assert.deepEqual(snapshot.state, expected)
})

test('a missing, corrupt or stale snapshot is rebuilt from the log', () => {
  const events = readStream('lifecycle')
  appendAll(events.slice(0, 4))
  const dir = boardDir({ board: 'default' })
  const early = readFileSync(join(dir, 'snapshot.json'))
  appendAll(events.slice(4))
  const expected = replay({ state: emptyBoard(), events })

  // Crash between the append and the snapshot write: the old snapshot plus the log tail.
  writeFileSync(join(dir, 'snapshot.json'), early)
  assert.deepEqual(loadBoard({ board: 'default' }).state, expected)
  writeFileSync(join(dir, 'snapshot.json'), '{not json')
  assert.deepEqual(loadBoard({ board: 'default' }).state, expected)
  rmSync(join(dir, 'snapshot.json'))
  assert.deepEqual(loadBoard({ board: 'default' }).state, expected)
})

test('appends must continue the sequence', () => {
  appendAll(readStream('lifecycle').slice(0, 1))
  const [, second] = readStream('lifecycle')
  assert.throws(() => appendAll([{ ...second!, seq: 5 }]), /out of sequence/)
})

test('a torn tail is skipped on read, blocks writes and is set aside by repair', () => {
  const dir = seedLog('torn-tail')
  const original = readFileSync(join(dir, 'events.jsonl'))
  const clean = original.subarray(0, original.lastIndexOf(10) + 1)

  const loaded = loadBoard({ board: 'default' })
  assert.equal(loaded.state.seq, 3)
  assert.equal(loaded.tornBytes, original.length - clean.length)
  assertGolden('torn-tail', loaded.state)
  rejects(() => withWriter({ board: 'default', fn: () => undefined }), 'TORN_TAIL')

  const result = repairBoard({ board: 'default' })
  assert.equal(result.tornBytes, loaded.tornBytes)
  assert.deepEqual(readFileSync(result.preserved!), original.subarray(clean.length))
  // The log is only appended to: the torn bytes stay, closed by a repair marker.
  const repaired = readFileSync(join(dir, 'events.jsonl'))
  assert.deepEqual(repaired.subarray(0, original.length), original)
  const marker = JSON.parse(repaired.subarray(original.length + 1).toString('utf8'))
  assert.deepEqual(marker.data, { offset: clean.length, length: original.length - clean.length })
  assert.equal(loadBoard({ board: 'default' }).tornBytes, 0)

  const [first] = readStream('torn-tail')
  appendAll([{ ...first!, seq: 4, id: 'evt_4', type: 'card.moved', data: { before: 'review', after: null } }])
  assert.equal(loadBoard({ board: 'default' }).state.cards.c1!.column, 'review')
  rmSync(join(dir, 'snapshot.json'))
  assert.equal(loadBoard({ board: 'default' }).state.seq, 4)
  assert.equal(repairBoard({ board: 'default' }).tornBytes, 0)
})

test('repair skips a torn line even when it parses as an event', () => {
  const dir = seedLog('lifecycle')
  const events = readStream('lifecycle')
  const unacknowledged = JSON.stringify({ ...events[0]!, seq: 9, id: 'evt_9', data: { key: 'ghost' } })
  writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl')).toString() + unacknowledged)
  repairBoard({ board: 'default' })
  rmSync(join(dir, 'snapshot.json'))
  assert.deepEqual(loadBoard({ board: 'default' }).state, replay({ state: emptyBoard(), events }))
})

test('a repair marker that names the wrong line is corruption', () => {
  const dir = seedLog('lifecycle')
  const marker = { v: 1, type: 'log.repaired', at: '2026-10-13T00:00:00Z', data: { offset: 0, length: 1 } }
  writeFileSync(join(dir, 'events.jsonl'), `${readFileSync(join(dir, 'events.jsonl'))}${JSON.stringify(marker)}\n`)
  rejects(() => loadBoard({ board: 'default' }), 'LOG_CORRUPT')
})

test('corruption inside the log is rejected, not skipped', () => {
  const dir = seedLog('lifecycle')
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')
  lines[2] = '{garbage'
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'))
  rejects(() => loadBoard({ board: 'default' }), 'LOG_CORRUPT')
})

test('a lock left by a dead process is taken over', () => {
  const dir = boardDir({ board: 'default' })
  mkdirSync(dir, { recursive: true })
  const dead = spawnSync(process.execPath, ['-e', '']).pid!
  writeFileSync(join(dir, 'writer.lock'), String(dead))
  appendAll(readStream('lifecycle').slice(0, 1))
  assert.equal(existsSync(join(dir, 'writer.lock')), false)
})

test('board names cannot escape the boards folder', () => {
  rejects(() => boardDir({ board: '../etc' }), 'VALIDATION_ERROR')
  rejects(() => boardDir({ board: 'a/b' }), 'VALIDATION_ERROR')
})
