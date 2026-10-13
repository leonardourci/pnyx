// Per-board files: the append-only events.jsonl, the snapshot.json cache, the
// writer lock and the hook spool.
import {
  closeSync,
  existsSync,
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
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoardError, EVENT_TYPES, EVENT_VERSION, type BoardEvent, type BoardState } from "../core/model.ts";
import { emptyBoard, reduce, replay } from "../core/reducer.ts";

const LOCK_TIMEOUT_MS = 5000;
const STALE_EMPTY_LOCK_MS = 10_000;

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(homedir(), ".pnyx");
}

export function boardDir(board: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(board)) {
    throw new BoardError(`invalid board name: ${board}`, "VALIDATION_ERROR", [
      "Use letters, digits, dot, dash or underscore",
    ]);
  }
  return join(pnyxHome(), "boards", board);
}

const logPath = (dir: string) => join(dir, "events.jsonl");
const snapshotPath = (dir: string) => join(dir, "snapshot.json");
export const spoolDir = (dir: string) => join(dir, "spool");

interface LogRead {
  events: BoardEvent[];
  // Byte offset just past the last complete line.
  end: number;
  size: number;
}

function parseEvent(line: string, offset: number): BoardEvent {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    event = undefined;
  }
  const e = event as Partial<BoardEvent> | undefined;
  if (
    typeof e !== "object" ||
    e === null ||
    !Number.isInteger(e.seq) ||
    typeof e.id !== "string" ||
    typeof e.cardId !== "string" ||
    !EVENT_TYPES.includes(e.type as BoardEvent["type"])
  ) {
    throw new BoardError(`events.jsonl is corrupt at byte ${offset}`, "LOG_CORRUPT", [
      "The log is never rewritten automatically; inspect that line by hand",
    ]);
  }
  if (e.v !== EVENT_VERSION) {
    throw new BoardError(`event at byte ${offset} has schema v${e.v}; this pnyx-axi reads v${EVENT_VERSION}`, "UNSUPPORTED_VERSION");
  }
  return e as BoardEvent;
}

// Reads complete lines from `from`. Bytes after the last newline are a torn tail
// left by a crash mid-append: they are reported through `end` < `size`, never parsed.
function readLog(dir: string, from = 0): LogRead | null {
  const path = logPath(dir);
  if (!existsSync(path)) return from === 0 ? { events: [], end: 0, size: 0 } : null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (from > size) return null;
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const complete = buf.lastIndexOf(10) + 1;
    const events: BoardEvent[] = [];
    let offset = from;
    for (const line of buf.subarray(0, complete).toString("utf8").split("\n")) {
      if (line.trim() !== "") events.push(parseEvent(line, offset));
      offset += Buffer.byteLength(line) + 1;
    }
    return { events, end: from + complete, size };
  } finally {
    closeSync(fd);
  }
}

export function readEvents(board: string): BoardEvent[] {
  return readLog(boardDir(board))?.events ?? [];
}

interface Snapshot {
  v: typeof EVENT_VERSION;
  offset: number;
  state: BoardState;
}

function readSnapshot(dir: string): Snapshot | null {
  try {
    const snap = JSON.parse(readFileSync(snapshotPath(dir), "utf8")) as Snapshot;
    return snap.v === EVENT_VERSION && Number.isInteger(snap.offset) && snap.state?.v === EVENT_VERSION ? snap : null;
  } catch {
    return null;
  }
}

function writeSnapshot(dir: string, state: BoardState, offset: number): void {
  const tmp = `${snapshotPath(dir)}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify({ v: EVENT_VERSION, offset, state } satisfies Snapshot));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, snapshotPath(dir));
}

export interface Board {
  dir: string;
  state: BoardState;
  // Where the next append lands.
  offset: number;
  // Size of a torn tail, 0 when the log ends cleanly.
  tornBytes: number;
}

// Loads the snapshot and folds in any events appended after it. Falls back to a
// full replay when the snapshot is missing, unreadable or does not fit the log.
export function loadBoard(board: string): Board {
  const dir = boardDir(board);
  const snap = readSnapshot(dir);
  let log = snap ? readLog(dir, snap.offset) : null;
  let start = snap?.state ?? emptyBoard();
  if (!log || (snap && log.events.length > 0 && log.events[0]!.seq !== snap.state.seq + 1)) {
    log = readLog(dir) as LogRead;
    start = emptyBoard();
  }
  return { dir, state: replay(start, log.events), offset: log.end, tornBytes: log.size - log.end };
}

function lockIsStale(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - statSync(path).mtimeMs > STALE_EMPTY_LOCK_MS;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// O_EXCL lock file holding the writer's pid; a lock whose process is gone is taken over.
// ponytail: two writers can both judge the same dead lock stale; a lock daemon fixes it if that ever matters.
function acquireLock(dir: string): () => void {
  const path = join(dir, "writer.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockIsStale(path)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new BoardError("board is locked by another pnyx-axi writer", "LOCKED", [
        `Retry, or remove ${path} if no pnyx-axi process is running`,
      ]);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

export interface Writer {
  readonly state: BoardState;
  readonly dir: string;
  append(event: BoardEvent): void;
}

// Runs `fn` as the board's single writer. Each append is flushed to disk before
// the state advances; the snapshot is replaced afterwards.
export function withWriter<T>(board: string, fn: (writer: Writer) => T): T {
  const dir = boardDir(board);
  mkdirSync(dir, { recursive: true });
  const release = acquireLock(dir);
  try {
    let { state, offset } = loadTail(board);
    let dirty = false;
    try {
      return fn({
        dir,
        get state() {
          return state;
        },
        append(event) {
          if (event.seq !== state.seq + 1) throw new Error(`append out of sequence: ${event.seq} after ${state.seq}`);
          const line = `${JSON.stringify(event)}\n`;
          const fd = openSync(logPath(dir), "a");
          try {
            writeSync(fd, line);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          offset += Buffer.byteLength(line);
          state = reduce(state, event);
          dirty = true;
        },
      });
    } finally {
      if (dirty) writeSnapshot(dir, state, offset);
    }
  } finally {
    release();
  }
}

function loadTail(board: string): Board {
  const loaded = loadBoard(board);
  if (loaded.tornBytes > 0) {
    throw new BoardError(`events.jsonl ends with ${loaded.tornBytes} bytes of a torn append`, "TORN_TAIL", [
      "Run `pnyx-axi repair` to set them aside and continue",
    ]);
  }
  return loaded;
}

export interface Repair {
  tornBytes: number;
  preserved?: string;
  seq: number;
}

// Moves a torn tail into a side file, cuts the log back to its last complete line
// and rebuilds the snapshot from the full log. A torn tail was never acknowledged
// as written, so no accepted event is lost; its bytes stay on disk for inspection.
export function repairBoard(board: string): Repair {
  const dir = boardDir(board);
  mkdirSync(dir, { recursive: true });
  const release = acquireLock(dir);
  try {
    const log = readLog(dir) as LogRead;
    const tornBytes = log.size - log.end;
    let preserved: string | undefined;
    if (tornBytes > 0) {
      preserved = `${logPath(dir)}.torn-${log.end}`;
      writeFileSync(preserved, readFileSync(logPath(dir)).subarray(log.end));
      truncateSync(logPath(dir), log.end);
    }
    const state = replay(emptyBoard(), log.events);
    writeSnapshot(dir, state, log.end);
    return { tornBytes, ...(preserved ? { preserved } : {}), seq: state.seq };
  } finally {
    release();
  }
}

// Writes one hook event to the spool without taking the writer lock. The next
// writer ingests it; the spool is a buffer, never a second writer of the log.
export function spoolWrite(board: string, entry: { id: string } & Record<string, unknown>): string {
  const dir = spoolDir(boardDir(board));
  mkdirSync(dir, { recursive: true });
  // Millisecond time orders files across processes; hrtime keeps same-millisecond writes apart.
  const name = `${String(Date.now()).padStart(15, "0")}-${process.hrtime.bigint()}-${entry.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  const tmp = join(dir, `.tmp-${process.pid}-${name}`);
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, join(dir, name));
  return join(dir, name);
}

// Spooled files in arrival order.
export function spoolFiles(dir: string): string[] {
  const spool = spoolDir(dir);
  if (!existsSync(spool)) return [];
  return readdirSync(spool)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => join(spool, f));
}
