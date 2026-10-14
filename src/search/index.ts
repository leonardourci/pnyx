// search.db: a derived full-text index over a board's event log and the
// transcripts its hooks recorded. It is a deletable cache, never board state;
// the indexer below is its only writer and rebuilds it from the sources.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardError } from "../core/model.ts";
import { boardDir, loadBoard, readEventsFrom } from "../store/board-store.ts";
import { CHUNKER_VERSION, chunk, eventText, redact, transcriptMessages } from "./text.ts";

// Bump when the tables change; the index rebuilds on mismatch.
export const SCHEMA_VERSION = 2;
export const KINDS = ["event", "transcript"] as const;
export type Kind = (typeof KINDS)[number];

const EVENTS = "events";

// pos is the event seq for an event, or the byte offset of the JSONL line for a
// transcript; part numbers the chunks taken from it. context repeats the card's title
// and link titles on every row, so the words of one query can match across a card.
// Vectors can later key on docs.id.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  card TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  pos INTEGER NOT NULL,
  part INTEGER NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  context TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (source, pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card ON docs (card);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (body, context, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts (rowid, body, context) VALUES (new.id, new.body, new.context);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts (docs_fts, rowid, body, context) VALUES ('delete', old.id, old.body, old.context);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF context ON docs BEGIN
  INSERT INTO docs_fts (docs_fts, rowid, body, context) VALUES ('delete', old.id, old.body, old.context);
  INSERT INTO docs_fts (rowid, body, context) VALUES (new.id, new.body, new.context);
END;
CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, card TEXT NOT NULL, identity TEXT NOT NULL, pos INTEGER NOT NULL, seq INTEGER NOT NULL);
`;

const require = createRequire(import.meta.url);

// Node 22 prints an ExperimentalWarning to stderr when node:sqlite loads; it is the
// only experimental module Pnyx uses, so warnings are muted for that one load.
function sqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

export const searchPath = (board: string) => join(boardDir(board), "search.db");

function removeIndex(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function isCurrent(db: DatabaseSync): boolean {
  try {
    return metaValue(db, "index_schema_version") === String(SCHEMA_VERSION) && metaValue(db, "chunker_version") === String(CHUNKER_VERSION);
  } catch {
    return false;
  }
}

// Opens the index for writing, creating it, or deleting and recreating it when it
// was built by another schema or chunker version.
// ponytail: a rebuild deletes the file under any concurrent reader; it reopens on its next query.
function openWriter(board: string, fresh = false): DatabaseSync {
  const { DatabaseSync } = sqlite();
  const path = searchPath(board);
  mkdirSync(boardDir(board), { recursive: true });
  if (fresh) removeIndex(path);
  if (existsSync(path)) {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    if (isCurrent(db)) return db;
    db.close();
    removeIndex(path);
  }
  const db = new DatabaseSync(path);
  // Transcript text is as private as the transcripts.
  chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  // IF NOT EXISTS lets two first runs race to create the same file.
  db.exec(`BEGIN IMMEDIATE; ${SCHEMA}
    INSERT OR REPLACE INTO meta (key, value) VALUES ('index_schema_version', '${SCHEMA_VERSION}'), ('chunker_version', '${CHUNKER_VERSION}');
    COMMIT;`);
  return db;
}

interface Cursor {
  source: string;
  card: string;
  identity: string;
  pos: number;
  seq: number;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface IndexResult {
  events: number;
  transcripts: number;
  docs: number;
}

// Folds what the log and the recorded transcripts gained since the cursors into
// the index, in one transaction. SQLite's write lock keeps two indexers apart.
function catchUp(db: DatabaseSync, board: string): IndexResult {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO docs (card, kind, source, pos, part, at, body, context, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const cards = Object.values(loadBoard(board).state.cards);
  const context = new Map(cards.map((c) => [c.id, redact([c.title, ...c.links.map((l) => l.title)].filter(Boolean).join("\n"))]));
  let docs = 0;
  const add = (card: string, kind: Kind, source: string, pos: number, at: string, text: string, firstPart = 0): number => {
    let part = firstPart;
    for (const body of chunk(redact(text))) {
      const hash = createHash("sha256").update(body).digest("hex");
      docs += Number(insert.run(card, kind, source, pos, part, at, body, context.get(card) ?? "", hash).changes);
      part += 1;
    }
    return part;
  };
  const getCursor = db.prepare("SELECT * FROM cursors WHERE source = ?");
  const putCursor = db.prepare(
    "INSERT INTO cursors (source, card, identity, pos, seq) VALUES (:source, :card, :identity, :pos, :seq) " +
      "ON CONFLICT (source) DO UPDATE SET identity = :identity, pos = :pos, seq = :seq",
  );
  const track = db.prepare("INSERT OR IGNORE INTO cursors (source, card, identity, pos, seq) VALUES (?, ?, '', 0, 0)");

  return transaction(db, () => {
    let cursor = (getCursor.get(EVENTS) as Cursor | undefined) ?? { source: EVENTS, card: "", identity: "", pos: 0, seq: 0 };
    let read = readEventsFrom(board, cursor.pos);
    // The log never shrinks or reorders, so a mismatch means the index is from another log: start over.
    if (!read || (read.events.length > 0 && read.events[0]!.seq !== cursor.seq + 1)) {
      db.exec("DELETE FROM docs; DELETE FROM cursors;");
      cursor = { ...cursor, pos: 0, seq: 0 };
      read = readEventsFrom(board, 0)!;
    }
    for (const event of read.events) {
      add(event.cardId, "event", EVENTS, event.seq, event.at, eventText(event));
      const path = event.type === "card.pushed" ? event.data.agent?.transcriptPath : undefined;
      if (path && isAbsolute(path) && path.endsWith(".jsonl")) track.run(path, event.cardId);
    }
    putCursor.run({ ...cursor, pos: read.end, seq: read.events.at(-1)?.seq ?? cursor.seq });

    db.exec("DELETE FROM cards");
    const putCard = db.prepare("INSERT INTO cards (id, title, workspace) VALUES (?, ?, ?)");
    const putContext = db.prepare("UPDATE docs SET context = :context WHERE card = :card AND context <> :context");
    for (const card of cards) {
      putCard.run(card.id, card.title, card.workspace);
      putContext.run({ card: card.id, context: context.get(card.id)! });
    }

    let transcripts = 0;
    const dropSource = db.prepare("DELETE FROM docs WHERE source = ?");
    for (const t of db.prepare("SELECT * FROM cursors WHERE source <> ?").all(EVENTS) as unknown as Cursor[]) {
      const tail = readTranscript(t);
      if (!tail) continue;
      if (tail.reset) dropSource.run(t.source);
      for (const line of tail.lines) {
        let part = 0;
        for (const m of transcriptMessages(line.record)) part = add(t.card, "transcript", t.source, line.pos, m.at ?? "", m.text, part);
      }
      putCursor.run({ ...t, identity: tail.identity, pos: tail.end, seq: 0 });
      transcripts += tail.lines.length > 0 ? 1 : 0;
    }
    return { events: read.events.length, transcripts, docs };
  });
}

interface TranscriptRead {
  identity: string;
  // The cursor no longer fits the file: drop what was indexed from it and read it again.
  reset: boolean;
  lines: { pos: number; record: unknown }[];
  end: number;
}

// Complete JSONL lines after the cursor. A replaced file (another device and
// inode) or one shorter than the cursor is read again from the start. Null when
// the file is missing or unreadable, so the cursor waits for it.
// ponytail: reads the unread tail in one buffer; stream it if transcripts grow past memory.
function readTranscript(cursor: Cursor): TranscriptRead | null {
  let fd: number;
  try {
    fd = openSync(cursor.source, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const identity = `${stat.dev}:${stat.ino}`;
    const reset = (cursor.identity !== "" && cursor.identity !== identity) || stat.size < cursor.pos;
    const from = reset ? 0 : cursor.pos;
    const buf = Buffer.alloc(stat.size - from);
    readSync(fd, buf, 0, buf.length, from);
    const complete = buf.lastIndexOf(10) + 1;
    const lines: TranscriptRead["lines"] = [];
    for (let start = 0; start < complete; ) {
      const end = buf.indexOf(10, start);
      try {
        lines.push({ pos: from + start, record: JSON.parse(buf.toString("utf8", start, end)) });
      } catch {
        // Not JSON: nothing to index on this line.
      }
      start = end + 1;
    }
    return { identity, reset, lines, end: from + complete };
  } finally {
    closeSync(fd);
  }
}

export function updateIndex(board: string): IndexResult {
  const db = openWriter(board);
  try {
    return catchUp(db, board);
  } finally {
    db.close();
  }
}

export function rebuildIndex(board: string): IndexResult {
  const db = openWriter(board, true);
  try {
    return catchUp(db, board);
  } finally {
    db.close();
  }
}

export interface Query {
  text: string;
  kind?: Kind;
  card?: string;
  workspace?: string;
  limit: number;
}

export interface Hit {
  card: string;
  title: string;
  kind: Kind;
  at: string;
  match: "lexical";
  snippet: string;
}

// The user's words as an FTS5 query: every term must match (FTS5's default AND)
// somewhere on one row, its own text or its card's context,
// each quoted so punctuation is never read as query syntax; a trailing * keeps
// prefix matching.
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => {
      const prefix = term.endsWith("*") ? "*" : "";
      return `"${(prefix ? term.slice(0, -1) : term).replace(/"/g, '""')}"${prefix}`;
    })
    .join(" ");
}

// BM25-ranked hits, best first, a context match weighing half a body match, ties broken by row id. Without a card filter each
// card shows once, with its best chunk.
export function search(board: string, query: Query): { hits: Hit[]; total: number } {
  const match = ftsQuery(query.text);
  if (!match) throw new BoardError("query has no words to search for", "VALIDATION_ERROR", ['Run `pnyx-axi search "<words>"`']);
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(searchPath(board), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db
      .prepare(
        `WITH hits AS (
           SELECT d.id, d.card, d.kind, d.at, bm25(docs_fts, 1.0, 0.5) AS rank
           FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid LEFT JOIN cards c ON c.id = d.card
           WHERE docs_fts MATCH :match
             AND (:kind IS NULL OR d.kind = :kind)
             AND (:card IS NULL OR d.card = :card)
             AND (:workspace IS NULL OR c.workspace = :workspace)
         ), best AS (
           SELECT *, row_number() OVER (PARTITION BY CASE WHEN :card IS NULL THEN card ELSE id END ORDER BY rank, id) AS n FROM hits
         )
         SELECT id, card, kind, at, count(*) OVER () AS total FROM best WHERE n = 1 ORDER BY rank, id LIMIT :limit`,
      )
      .all({ match, kind: query.kind ?? null, card: query.card ?? null, workspace: query.workspace ?? null, limit: query.limit }) as {
      id: number;
      card: string;
      kind: Kind;
      at: string;
      total: number;
    }[];
    // The rowid is bound as a BigInt: FTS5 ignores a rowid constraint bound as a float, which a JS number is.
    const snippet = db.prepare("SELECT snippet(docs_fts, -1, '[', ']', '…', 16) AS s FROM docs_fts WHERE docs_fts MATCH ? AND rowid = ?");
    const title = db.prepare("SELECT title FROM cards WHERE id = ?");
    const hits = rows.map((r) => ({
      card: r.card,
      title: (title.get(r.card) as { title: string } | undefined)?.title ?? r.card,
      kind: r.kind,
      at: r.at || "unknown",
      match: "lexical" as const,
      snippet: (snippet.get(match, BigInt(r.id)) as { s: string }).s.replace(/\s+/g, " "),
    }));
    return { hits, total: rows[0]?.total ?? 0 };
  } finally {
    db.close();
  }
}

export interface IndexStatus {
  builtThrough: number;
  docs: Record<Kind, number>;
  transcripts: { tracked: number; missing: number };
  bytes: number;
  current: boolean;
}

// Reads the index without writing it. Null when it has not been built.
export function indexStatus(board: string): IndexStatus | null {
  const path = searchPath(board);
  if (!existsSync(path)) return null;
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const bytes = statSync(path).size;
    if (!isCurrent(db)) return { builtThrough: 0, docs: { event: 0, transcript: 0 }, transcripts: { tracked: 0, missing: 0 }, bytes, current: false };
    const count = (kind: Kind) => (db.prepare("SELECT count(*) AS n FROM docs WHERE kind = ?").get(kind) as { n: number }).n;
    const cursors = db.prepare("SELECT * FROM cursors").all() as unknown as Cursor[];
    const transcripts = cursors.filter((c) => c.source !== EVENTS);
    return {
      builtThrough: cursors.find((c) => c.source === EVENTS)?.seq ?? 0,
      docs: { event: count("event"), transcript: count("transcript") },
      transcripts: { tracked: transcripts.length, missing: transcripts.filter((c) => !existsSync(c.source)).length },
      bytes,
      current: true,
    };
  } finally {
    db.close();
  }
}
