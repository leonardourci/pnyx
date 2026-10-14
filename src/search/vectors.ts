// The vector side of search.db: one vector per distinct chunk text, keyed by the
// chunk's content hash, so repeated text, a re-read transcript or a log rebuild
// re-embeds nothing it already holds. The meta table names the backend that made
// the vectors; vectors from any other are dropped and made again.
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { sqlite, searchPath, type Kind } from './index.ts'

const require = createRequire(import.meta.url)

const VECTORS = 'CREATE TABLE IF NOT EXISTS vectors (hash TEXT PRIMARY KEY, embedding BLOB NOT NULL) WITHOUT ROWID'
// Below this cosine between a probe's stored and fresh vector, the runtime has
// changed the vectors (round-off across versions is about 1e-7).
const PROBE_MATCH = 0.9999

const blob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
const floats = (b: Uint8Array) =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)

function meta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

// Opens the board's index to write vectors, or null when it has not been built.
export function openVectors(board: string): DatabaseSync | null {
  const { DatabaseSync } = sqlite()

  if (!existsSync(searchPath(board))) {
    return null
  }

  const db = new DatabaseSync(searchPath(board))

  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(VECTORS)

    return db
  } catch {
    db.close()

    return null
  }
}

// Keeps the vectors when they came from this backend and its probes still embed
// the same; otherwise drops them all and records this backend.
export function claimVectors(db: DatabaseSync, key: string, probes: Float32Array[]): void {
  const stored = meta(db, 'embed.probes')
  const same =
    meta(db, 'embed.key') === key &&
    stored !== undefined &&
    (JSON.parse(stored) as string[]).every((p, i) => {
      const v = floats(Buffer.from(p, 'base64'))

      const fresh = probes[i]

      return fresh !== undefined && v.length === fresh.length && dot(v, fresh) >= PROBE_MATCH
    })

  if (same) {
    return
  }

  db.exec('BEGIN IMMEDIATE')

  try {
    db.exec('DELETE FROM vectors')
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    put.run('embed.key', key)
    put.run('embed.probes', JSON.stringify(probes.map(p => Buffer.from(blob(p)).toString('base64'))))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Distinct chunk texts with no vector yet, newest first, leaving out the hashes given.
export function pending(
  db: DatabaseSync,
  limit: number,
  skip: ReadonlySet<string> = new Set(),
): { hash: string; body: string }[] {
  const rows = db
    .prepare('SELECT content_hash AS hash, body FROM docs d WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash = d.content_hash) ORDER BY id DESC LIMIT ?')
    .all(limit + skip.size) as { hash: string; body: string }[]
  const seen = new Set(skip)

  return rows.filter(r => !seen.has(r.hash) && seen.add(r.hash)).slice(0, limit)
}

export function putVectors(db: DatabaseSync, rows: { hash: string; vector: Float32Array }[]): void {
  const put = db.prepare('INSERT OR IGNORE INTO vectors (hash, embedding) VALUES (?, ?)')
  db.exec('BEGIN IMMEDIATE')

  try {
    for (const r of rows) {
      put.run(r.hash, blob(r.vector))
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface Nearest {
  card: string
  title: string
  kind: Kind
  at: string
  body: string
  // Cosine similarity of the card's nearest chunk.
  similarity: number
}

export interface VectorRead {
  nearest: Nearest[]
  // Entries with a vector from this backend, of all entries.
  embedded: number
  total: number
}

// Cards by their chunk nearest the query vector, an exact scan with sqlite-vec's
// cosine distance over the chunks the filters leave. Only vectors from the given
// backend count; none do while the worker re-embeds for a new one.
// ponytail: a full scan, about 50 ms at 100k chunks; a vec0 index if boards grow far past that.
export function nearestCards(
  board: string,
  key: string,
  query: Float32Array,
  filters: { kind?: Kind; workspace?: string },
  limit: number,
): VectorRead {
  return withReader(board, key, (db, counts) => {
    if (!counts.embedded) {
      return { nearest: [], ...counts }
    }

    db.loadExtension((require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath())
    db.enableLoadExtension(false)
    const rows = db
      .prepare(
        `SELECT d.card, c.title, d.kind, d.at, d.body, min(vec_distance_cosine(v.embedding, :q)) AS distance
         FROM docs d JOIN vectors v ON v.hash = d.content_hash JOIN cards c ON c.id = d.card
         WHERE (:kind IS NULL OR d.kind = :kind) AND (:workspace IS NULL OR c.workspace = :workspace)
         GROUP BY d.card ORDER BY distance, d.card LIMIT :limit`,
      )
      .all({ q: blob(query), kind: filters.kind ?? null, workspace: filters.workspace ?? null, limit }) as (Omit<Nearest, 'similarity'> & { distance: number })[]

    const nearest = rows.map(({ distance, ...r }) => ({ ...r, similarity: 1 - distance }))

    return { nearest, ...counts }
  })
}

// How many of the board's entries have a vector from this backend; null when the index is not built.
type Counts = { embedded: number; total: number }

export function vectorCounts(board: string, key: string): Counts | null {
  if (!existsSync(searchPath(board))) {
    return null
  }

  try {
    return withReader(board, key, (_db, counts) => counts)
  } catch {
    return null
  }
}

function withReader<T>(board: string, key: string, fn: (db: DatabaseSync, counts: Counts) => T): T {
  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(searchPath(board), { readOnly: true, allowExtension: true })

  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    const total = count('SELECT count(*) AS n FROM docs')
    const ready = count("SELECT count(*) AS n FROM sqlite_master WHERE name = 'vectors'") > 0 && meta(db, 'embed.key') === key
    const embedded = ready ? count('SELECT count(*) AS n FROM docs d JOIN vectors v ON v.hash = d.content_hash') : 0

    return fn(db, { embedded, total })
  } finally {
    db.close()
  }
}
