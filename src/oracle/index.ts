import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { readEvents } from '#app/event-log.ts'
import { HydraError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { privateDir } from '#store/storage.ts'
import type { Document } from './model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { chunk, eventText, redact } from './text.ts'
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
const INDEX_VERSION = 9
const CATCH_UP_BATCH_EVENTS = 500
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
  seq: number
  event: string
}

export function openIndex({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}) {
  const dir = hydraDir({ hydraId })
  privateDir({ dir })

  for (const leftover of RETIRED_INDEX_FILES) {
    rmSync(
      join(
        dir,
        leftover,
      ),
      { force: true },
    )
  }

  const path = join(
    dir,
    'oracle.db',
  )
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
  const getCursor = db.prepare("SELECT seq, event FROM cursors WHERE source='events'")
  const putCursor = db.prepare(`INSERT INTO cursors(source, pos, seq, event)
    VALUES('events', :seq, :seq, :event)
    ON CONFLICT(source) DO UPDATE SET pos=:seq, seq=:seq, event=:event`)
  const insert = db.prepare(`INSERT INTO docs(card, kind, at, text, pos, part)
    VALUES(?, ?, ?, ?, ?, ?)`)
  const putWords = db.prepare('INSERT INTO words(rowid, terms, stems) VALUES(?, ?, ?)')

  const throughEvents = state.seq
  let pendingEvents = true

  while (pendingEvents) {
    const cursor = (getCursor.get() as unknown as Cursor | undefined) ?? {
      seq: 0,
      event: '',
    }
    const read = readEvents({
      hydraId,
      after: cursor.seq,
      limit: CATCH_UP_BATCH_EVENTS,
      before: throughEvents + 1,
    })
    const captured = !cursor.event || state.eventIds[cursor.event] === cursor.seq
    // A cursor past this state belongs only while the Hydra still holds the event it stopped at.
    const ahead = cursor.seq > state.seq && readEvents({
      hydraId,
      after: cursor.seq - 1,
      limit: 1,
    })[0]?.id === cursor.event
    const belongs = captured || ahead

    if (!belongs) {
      if (cursor.seq === 0) {
        throw new HydraError({
          code: 'LOG_CORRUPT',
          message: 'Event log does not start at its first event',
        })
      }

      // A restored or replaced Hydra leaves the derived cache behind; rebuild it from its events.
      transaction({
        db,
        fn: () => {
          const current = getCursor.get() as unknown as Cursor | undefined

          if (current?.seq === cursor.seq && current.event === cursor.event) {
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

    if ((read.at(-1)?.seq ?? cursor.seq) === cursor.seq) {
      break
    }

    let superseded = false
    transaction({
      db,
      fn: () => {
        const current = getCursor.get() as unknown as Cursor | undefined

        if (current && current.seq !== cursor.seq) {
          superseded = true

          return
        }

        for (const event of read) {
          let part = 0

          for (const entry of eventDocuments({ event })) {
            const words = tokens({ text: fold({ text: entry.text }) })
            const inserted = insert.run(
              entry.card,
              entry.kind,
              entry.at,
              entry.text,
              event.seq,
              part,
            )
            putWords.run(
              inserted.lastInsertRowid,
              words.join(' '),
              words.map(word => `s${inflection({ word })}`).join(' '),
            )
            part++
          }
        }

        putCursor.run({
          seq: read.at(-1)?.seq ?? cursor.seq,
          event: read.at(-1)?.id ?? cursor.event,
        })
      },
    })
    pendingEvents = superseded || (read.at(-1)?.seq ?? cursor.seq) < throughEvents
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

function* documentChunks({
  card,
  kind,
  at,
  text,
}: Document): Generator<Document> {
  for (const body of chunk({ text: redact({ text }) })) {
    yield {
      card: card === HYDRA_CARD ? '$board' : card,
      kind,
      at,
      text: body,
    }
  }
}

function* eventDocuments({ event }: { event: HydraEvent }): Generator<Document> {
  if (event.type === 'chat.message' || event.type === 'hydra.memory' || event.type === 'hydra.review') {
    return
  }

  if (event.type === 'hydra.helper-finished') {
    for (const outcome of event.data.outcomes) {
      if (outcome.status !== 'handled' && outcome.status !== 'still_waiting') {
        yield* documentChunks({
          card: outcome.task,
          kind: 'event',
          at: event.at,
          text: outcome.summary,
        })
      }
    }

    return
  }

  yield* documentChunks({
    card: event.cardId,
    kind: event.type === 'card.noted' ? 'note' : 'event',
    at: event.type === 'card.noted' ? event.data.at ?? event.at : event.at,
    text: eventText({ event }),
  })
}
