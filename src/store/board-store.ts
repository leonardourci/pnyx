// Per-board files: the append-only events.jsonl, the snapshot.json cache, the
// writer lock and the hook spool.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BoardError, EVENT_TYPES, EVENT_VERSION, type BoardEvent, type BoardState } from '../core/model.ts'
import { emptyBoard, reduce, replay } from '../core/reducer.ts'

const LOCK_TIMEOUT_MS = 5000
const STALE_EMPTY_LOCK_MS = 10_000

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(homedir(), '.pnyx')
}

export function boardDir({ board }: { board: string }): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(board)) {
    throw new BoardError({
      message: `invalid board name: ${board}`,
      code: 'VALIDATION_ERROR',
      help: [
        'Use letters, digits, dot, dash or underscore',
      ],
    })
  }

  return join(pnyxHome(), 'boards', board)
}

// Board files hold copied transcript text, which is as private as the transcripts.
export function privateDir({ dir }: { dir: string }): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

const logPath = ({ dir }: { dir: string }) => join(dir, 'events.jsonl')
const snapshotPath = ({ dir }: { dir: string }) => join(dir, 'snapshot.json')
export const spoolDir = ({ dir }: { dir: string }) => join(dir, 'spool')

interface LogRead {
  events: BoardEvent[]
  // Byte offset just past the last complete line.
  end: number
  size: number
}

// Appended by repair after it closes a torn line with a newline. Readers skip the
// line it names; it is not a board event and takes no sequence number.
interface RepairMarker {
  v: typeof EVENT_VERSION
  type: 'log.repaired'
  at: string
  data: { offset: number; length: number }
}

function parseLine({ line }: { line: string }): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function repairMarker({ value }: { value: unknown }): RepairMarker | undefined {
  const m = value as Partial<RepairMarker> | undefined

  return m?.type === 'log.repaired' && Number.isInteger(m.data?.offset) && Number.isInteger(m.data?.length)
    ? m as RepairMarker
    : undefined
}

function corrupt({ offset }: { offset: number }): BoardError {
  return new BoardError({
    message: `events.jsonl is corrupt at byte ${offset}`,
    code: 'LOG_CORRUPT',
    help: [
      'The log is never rewritten automatically; inspect that line by hand',
    ],
  })
}

function toEvent({ event, offset }: { event: unknown; offset: number }): BoardEvent {
  const e = event as Partial<BoardEvent> | undefined

  if (
    typeof e !== 'object' ||
    e === null ||
    !Number.isInteger(e.seq) ||
    typeof e.id !== 'string' ||
    typeof e.cardId !== 'string' ||
    !EVENT_TYPES.includes(e.type as BoardEvent['type'])
  ) {
    throw corrupt({ offset })
  }

  if (e.v !== EVENT_VERSION) {
    throw new BoardError({ message: `event at byte ${offset} has schema v${e.v}; this pnyx-axi reads v${EVENT_VERSION}`, code: 'UNSUPPORTED_VERSION' })
  }

  return e as BoardEvent
}

// Reads complete lines from `from`. Bytes after the last newline are a torn tail
// left by a crash mid-append: they are reported through `end` < `size`, never parsed.
// A line named by the repair marker right after it is skipped, whatever it holds.
function readLog({ dir, from = 0 }: { dir: string; from?: number }): LogRead | null {
  const path = logPath({ dir })

  if (!existsSync(path)) {
    return from === 0 ? { events: [], end: 0, size: 0 } : null
  }

  const fd = openSync(path, 'r')

  try {
    const size = fstatSync(fd).size

    if (from > size) {
      return null
    }

    const buf = Buffer.alloc(size - from)
    readSync(fd, buf, 0, buf.length, from)
    const complete = buf.lastIndexOf(10) + 1
    const events: BoardEvent[] = []
    let previous: {
      offset: number
      length: number
      event?: BoardEvent
      error?: BoardError
    } | undefined

    for (let start = 0; start < complete; ) {
      const end = buf.indexOf(10, start)
      const offset = from + start
      const line = buf.toString('utf8', start, end)
      const length = end - start
      start = end + 1

      if (line.trim() === '') {
        continue
      }

      const value = parseLine({ line })

      const marker = repairMarker({ value })

      if (marker) {
        if (previous?.offset !== marker.data.offset || previous.length !== marker.data.length) {
          throw corrupt({ offset })
        }

        if (previous.event) {
          events.pop()
        }

        previous = undefined
        continue
      }

      if (previous?.error) {
        throw previous.error
      }

      previous = { offset, length }

      try {
        previous.event = toEvent({ event: value, offset })
        events.push(previous.event)
      } catch (error) {
        previous.error = error as BoardError
      }
    }

    if (previous?.error) {
      throw previous.error
    }

    return { events, end: from + complete, size }
  } finally {
    closeSync(fd)
  }
}

export function readEvents({ board }: { board: string }): BoardEvent[] {
  return readLog({ dir: boardDir({ board }) })?.events ?? []
}

// Complete events at or after byte `offset`, and the offset just past them.
// Null when the log is now shorter than `offset`, so the reader must start over.
export function readEventsFrom(
  { board, offset }: { board: string; offset: number },
): { events: BoardEvent[]; end: number } | null {
  const log = readLog({ dir: boardDir({ board }), from: offset })

  return log && { events: log.events, end: log.end }
}

// Bumped when the reducer derives cards differently, so an older cache is replayed.
const RULES = 7

interface Snapshot {
  v: typeof EVENT_VERSION
  rules?: number
  offset: number
  state: BoardState
}

function readSnapshot({ dir }: { dir: string }): Snapshot | null {
  try {
    const snap = JSON.parse(readFileSync(snapshotPath({ dir }), 'utf8')) as Snapshot

    return snap.v === EVENT_VERSION
      && snap.rules === RULES
      && Number.isInteger(snap.offset)
      && snap.state?.v === EVENT_VERSION
      ? snap
      : null
  } catch {
    return null
  }
}

// Writes and flushes to disk before returning. flag "a" appends, "w" replaces.
function writeDurably({ path, data, flag }: { path: string; data: string | Buffer; flag: 'a' | 'w' }): void {
  const fd = openSync(path, flag, 0o600)

  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeSnapshot({ dir, state, offset }: {
  dir: string
  state: BoardState
  offset: number
}): void {
  const tmp = `${snapshotPath({ dir })}.tmp-${process.pid}`
  writeDurably({ path: tmp, data: JSON.stringify({ v: EVENT_VERSION, rules: RULES, offset, state } satisfies Snapshot), flag: 'w' })
  renameSync(tmp, snapshotPath({ dir }))
}

export interface Board {
  dir: string
  state: BoardState
  // Where the next append lands.
  offset: number
  // Size of a torn tail, 0 when the log ends cleanly.
  tornBytes: number
}

// Loads the snapshot and folds in any events appended after it. Falls back to a
// full replay when the snapshot is missing, unreadable or does not fit the log.
export function loadBoard({ board }: { board: string }): Board {
  const dir = boardDir({ board })
  const snap = readSnapshot({ dir })
  let log = snap ? readLog({ dir, from: snap.offset }) : null
  let start = snap?.state ?? emptyBoard()

  if (!log || (snap && log.events.length > 0 && log.events[0]!.seq !== snap.state.seq + 1)) {
    log = readLog({ dir }) as LogRead
    start = emptyBoard()
  }

  return {
    dir,
    state: replay({
      state: start,
      events: log.events,
    }),
    offset: log.end,
    tornBytes: log.size - log.end,
  }
}

function lockIsStale({ path }: { path: string }): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8'))

    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(path).mtimeMs > STALE_EMPTY_LOCK_MS
    }

    process.kill(pid, 0)

    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// Re-checks staleness under an O_EXCL takeover file so only one writer can remove a dead lock.
// ponytail: a writer killed inside the takeover leaves the takeover file behind, and every later dead lock then needs the manual removal the LOCKED help names.
function takeOver({ path, takeover }: { path: string; takeover: string }): boolean {
  try {
    closeSync(openSync(takeover, 'wx'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }

    throw error
  }

  try {
    if (lockIsStale({ path })) {
      rmSync(path, { force: true })
    }
  } finally {
    rmSync(takeover, { force: true })
  }

  return true
}

// O_EXCL lock file holding the writer's pid; a lock whose process is gone is taken over.
function acquireLock({ dir }: { dir: string }): () => void {
  const path = join(dir, 'writer.lock')
  const takeover = `${path}.takeover`
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)

      return () => rmSync(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }

    if (lockIsStale({ path }) && takeOver({ path, takeover })) {
      continue
    }

    if (Date.now() > deadline) {
      throw new BoardError({
        message: 'board is locked by another pnyx-axi writer',
        code: 'LOCKED',
        help: [
          `Retry, or remove ${path} and ${takeover} if no pnyx-axi process is running`,
        ],
      })
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}

export interface Writer {
  readonly state: BoardState
  readonly dir: string
  append({ event }: { event: BoardEvent }): void
}

// Runs `fn` as the board's single writer. Each append is flushed to disk before
// the state advances; the snapshot is replaced afterwards.
export function withWriter<T>({ board, fn }: {
  board: string
  fn: (
    { writer }: {
      writer: Writer
    },
  ) => T
}): T {
  const dir = boardDir({ board })
  privateDir({ dir })
  const release = acquireLock({ dir })

  try {
    let { state, offset } = loadTail({ board })
    let dirty = false

    try {
      return fn({
        writer: {
          dir,
          get state() {
            return state
          },
          append({ event }) {
            if (event.seq !== state.seq + 1) {
              throw new Error(`append out of sequence: ${event.seq} after ${state.seq}`)
            }

            const card = state.cards[event.cardId]
            const parent = event.type === 'task.created' ? event.data.parentId : card?.parentId
            const session = event.type === 'task.session' ? event.data.session : card?.sessionIds?.[0]
            const agent = event.type === 'card.pushed' && event.data.agent
              ? event.data.agent : session ? state.sessions?.[session]?.agent : card?.agent
            const observedSession = agent
              ? `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}` : session
            event = {
              boardId: board,
              ...(event.cardId !== '$board' ? { taskId: parent ?? event.cardId } : {}),
              ...(parent ? { subtaskId: event.cardId } : {}),
              ...(agent ? { agentId: `${agent.provider}:${agent.agentId ?? agent.sessionId}` } : {}),
              ...(observedSession ? { sessionId: observedSession } : {}),
              commandId: event.id,
              ...(event.type === 'card.replied' ? { messageId: event.data.reply } : {}),
              ...event,
            }
            const line = `${JSON.stringify(event)}\n`
            writeDurably({ path: logPath({ dir }), data: line, flag: 'a' })
            offset += Buffer.byteLength(line)
            state = reduce({ state, event })
            dirty = true
          },
        },
      })
    } finally {
      if (dirty) {
        writeSnapshot({ dir, state, offset })
      }
    }
  } finally {
    release()
  }
}

function loadTail({ board }: { board: string }): Board {
  const loaded = loadBoard({ board })

  if (loaded.tornBytes > 0) {
    throw new BoardError({
      message: `events.jsonl ends with ${loaded.tornBytes} bytes of a torn append`,
      code: 'TORN_TAIL',
      help: [
        'Run `pnyx-axi repair` to set them aside and continue',
      ],
    })
  }

  return loaded
}

export interface Repair {
  tornBytes: number
  preserved?: string
  seq: number
}

// Copies a torn tail to a side file, then closes it with a newline and a repair
// marker so readers skip that line; the log itself is never cut. A torn tail was
// never acknowledged as written, so no accepted event is lost.
// ponytail: a crash while appending the marker leaves a corrupt interior line; inspect it by hand.
export function repairBoard({ board }: { board: string }): Repair {
  const dir = boardDir({ board })
  privateDir({ dir })
  const release = acquireLock({ dir })

  try {
    let log = readLog({ dir }) as LogRead
    const tornBytes = log.size - log.end
    let preserved: string | undefined

    if (tornBytes > 0) {
      preserved = `${logPath({ dir })}.torn-${log.end}`
      writeDurably({ path: preserved, data: readFileSync(logPath({ dir })).subarray(log.end), flag: 'w' })
      const marker: RepairMarker = {
        v: EVENT_VERSION,
        type: 'log.repaired',
        at: new Date().toISOString(),
        data: { offset: log.end, length: tornBytes },
      }
      writeDurably({ path: logPath({ dir }), data: `\n${JSON.stringify(marker)}\n`, flag: 'a' })
      log = readLog({ dir }) as LogRead
    }

    const state = replay({ state: emptyBoard(), events: log.events })
    writeSnapshot({ dir, state, offset: log.end })

    return { tornBytes, ...(preserved ? { preserved } : {}), seq: state.seq }
  } finally {
    release()
  }
}

// Writes one hook event to the spool without taking the writer lock. The next
// writer ingests it; the spool is a buffer, never a second writer of the log.
export function spoolWrite({ board, entry }: {
  board: string
  entry: {
    id: string
  } & Record<string, unknown>
}): string {
  const dir = spoolDir({ dir: boardDir({ board }) })
  privateDir({ dir })
  // Millisecond time orders files across processes; hrtime keeps same-millisecond writes apart.
  const name = `${String(Date.now()).padStart(15, '0')}-${process.hrtime.bigint()}-${entry.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
  const tmp = join(dir, `.tmp-${process.pid}-${name}`)
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
  renameSync(tmp, join(dir, name))

  return join(dir, name)
}

// Spooled files in arrival order.
export function spoolFiles({ dir }: { dir: string }): string[] {
  const spool = spoolDir({ dir })

  if (!existsSync(spool)) {
    return []
  }

  return readdirSync(spool)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map(f => join(spool, f))
}
