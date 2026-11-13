import { chmodSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import type { HydraState } from '#app/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { HydraError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { logPath, privateDir } from '#store/storage.ts'
import { eventDocuments, type Document } from './documents.ts'
import { fold, inflection, matches, tokens, type Term } from './query.ts'

const require = createRequire(import.meta.url)

function sqlite(): typeof import('node:sqlite') {
  const warning = process.emitWarning
  // Node 22 warns when its built-in SQLite module loads; CLI output stays structured.
  process.emitWarning = () => {}

  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = warning
  }
}

// Bump when the schema, stored text, visibility or tokenization changes.
const INDEX_VERSION = 4
const CATCH_UP_BATCH_BYTES = 256 * 1024
const EVENTS = 'events'
// The full-text index an earlier version kept beside each Hydra.
const RETIRED_INDEX_FILES = [
  'search.db',
  'search.db-wal',
  'search.db-shm',
]
// Oracle indexes Pnyx data only: cards, their events and notes, never agent transcripts.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY, pos INTEGER NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, card TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL,
  text TEXT NOT NULL, pos INTEGER NOT NULL, part INTEGER NOT NULL, UNIQUE(pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card_at ON docs(card, at);
CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(terms, stems, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_delete AFTER DELETE ON docs BEGIN
  DELETE FROM words WHERE rowid=old.id;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary USING fts5vocab(words, 'col');
`

interface Cursor {
  source: string
  pos: number
  seq: number
  event: string
}

export const searchPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'oracle.db',
)

export function openIndex({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}) {
  privateDir({ dir: hydraDir({ hydraId }) })

  for (const leftover of RETIRED_INDEX_FILES) {
    rmSync(
      join(
        hydraDir({ hydraId }),
        leftover,
      ),
      { force: true },
    )
  }

  const path = searchPath({ hydraId })
  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(path)

  try {
    chmodSync(
      path,
      0o600,
    )
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }

    if (version.user_version !== INDEX_VERSION) {
      transaction({
        db,
        fn: () => {
          const current = db.prepare('PRAGMA user_version').get() as { user_version: number }

          if (current.user_version === INDEX_VERSION) {
            return
          }

          recreate({ db })
        },
      })
    }

    catchUp({
      db,
      hydraId,
      state,
    })
  } catch (error) {
    db.close()
    throw error
  }

  const latest = db.prepare('SELECT max((julianday(at) - 2440587.5) * 86400000) AS at FROM docs WHERE card=?')

  return {
    newestAt({ card }: { card: string }) {
      const row = latest.get(card) as { at: number | null }

      return Math.round(row.at ?? 0)
    },
    documents({
      terms,
      fuzzy,
    }: {
      terms: Term[]
      fuzzy: boolean
    }): Document[] {
      const quoted = ({ text }: { text: string }) => `"${text.replaceAll(
        '"',
        '""',
      )}"`
      const expressions = terms.flatMap(term => term.alts.flatMap(alt => {
        const words = tokens({ text: fold({ text: alt }) })
        const phrase = words.join(' ')

        if (!phrase) {
          return []
        }

        const body = `terms : ${quoted({ text: phrase })}${term.prefix ? '*' : ''}`

        if (words.length !== 1 || term.prefix) {
          return [body]
        }

        return [
          body,
          `stems : ${quoted({ text: `s${inflection({ word: phrase })}` })}`,
        ]
      }))

      if (fuzzy) {
        const vocabulary = db.prepare("SELECT term FROM vocabulary WHERE col = 'terms'").all() as {term: string}[]

        for (const row of vocabulary) {
          if (terms.some(term => matches({
            word: row.term,
            term,
            fuzzy: true,
          }))) {
            expressions.push(`terms : ${quoted({ text: row.term })}`)
          }
        }
      }

      if (!expressions.length) {
        return []
      }

      return db.prepare('SELECT d.card, d.kind, d.at, d.text FROM words JOIN docs d ON d.id=words.rowid WHERE words MATCH ? ORDER BY d.id')
        .all(expressions.join(' OR ')) as unknown as Document[]
    },
    close: () => db.close(),
  }
}

function catchUp({
  db,
  hydraId,
  state,
}: {
  db: DatabaseSync
  hydraId: string
  state: HydraState
}) {
  const getCursor = db.prepare('SELECT * FROM cursors WHERE source=?')
  const putCursor = db.prepare(`INSERT INTO cursors(source, pos, seq, event)
    VALUES(:source, :pos, :seq, :event)
    ON CONFLICT(source) DO UPDATE SET pos=:pos, seq=:seq, event=:event`)
  const insert = db.prepare(`INSERT INTO docs(card, kind, at, text, pos, part)
    VALUES(?, ?, ?, ?, ?, ?)`)
  const putWords = db.prepare('INSERT INTO words(rowid, terms, stems) VALUES(?, ?, ?)')

  const add = ({
    entry,
    pos,
    part,
  }: {
    entry: Document
    pos: number
    part: number
  }) => {
    const words = tokens({ text: fold({ text: entry.text }) })
    const inserted = insert.run(
      entry.card,
      entry.kind,
      entry.at,
      entry.text,
      pos,
      part,
    )
    putWords.run(
      inserted.lastInsertRowid,
      words.join(' '),
      words.map(word => `s${inflection({ word })}`).join(' '),
    )
  }

  const eventLog = logPath({ dir: hydraDir({ hydraId }) })
  const throughEvents = existsSync(eventLog) ? statSync(eventLog).size : 0
  let pendingEvents = true

  while (pendingEvents) {
    const cursor = (getCursor.get(EVENTS) as unknown as Cursor | undefined) ?? {
      source: EVENTS,
      pos: 0,
      seq: 0,
      event: '',
    }
    const read = readEventsFrom({
      hydraId,
      offset: cursor.pos,
      maxBytes: CATCH_UP_BATCH_BYTES,
      through: throughEvents,
    })
    const captured = !cursor.event || state.eventIds[cursor.event] === cursor.seq
    const belongs = captured || cursor.seq > state.seq

    const continues = !read?.events.length || read.events[0]!.seq === cursor.seq + 1

    if (!read || !belongs || !continues) {
      if (cursor.pos === 0) {
        throw new HydraError({
          code: 'LOG_CORRUPT',
          message: 'Event log does not start at its first event',
        })
      }

      // A restored or replaced events.jsonl leaves the derived cache behind; rebuild it from the log.
      transaction({
        db,
        fn: () => {
          const current = getCursor.get(EVENTS) as unknown as Cursor | undefined

          if (current?.pos === cursor.pos && current.event === cursor.event) {
            recreate({ db })
          }
        },
      })
      log({
        level: 'warn',
        operation: 'oracle.rebuild',
        hydraId,
        status: 'cursor does not belong to the event log',
      })
      continue
    }

    if (read.end === cursor.pos) {
      break
    }

    let superseded = false
    transaction({
      db,
      fn: () => {
        const current = getCursor.get(EVENTS) as unknown as Cursor | undefined

        if (current && current.pos !== cursor.pos) {
          superseded = true

          return
        }

        for (const event of read.events) {
          let part = 0

          for (const entry of eventDocuments({ event })) {
            add({
              entry,
              pos: event.seq,
              part,
            })
            part++
          }
        }

        putCursor.run({
          ...cursor,
          pos: read.end,
          seq: read.events.at(-1)?.seq ?? cursor.seq,
          event: read.events.at(-1)?.id ?? cursor.event,
        })
      },
    })
    pendingEvents = superseded || read.end < throughEvents
  }
}

function recreate({ db }: { db: DatabaseSync }) {
  db.exec('DROP TABLE IF EXISTS vocabulary; DROP TABLE IF EXISTS words; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS archived; DROP TABLE IF EXISTS cursors;')
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version=${INDEX_VERSION}`)
}

function transaction<T>({
  db,
  fn,
}: {
  db: DatabaseSync
  fn(): T
}): T {
  db.exec('BEGIN IMMEDIATE')

  try {
    const value = fn()
    db.exec('COMMIT')

    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
