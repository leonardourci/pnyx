import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import type { TitanEvent } from '#app/model.ts'
import { titanDir } from '#app/home-migration.ts'
import { nativeEvent } from '#app/native-state.ts'
import { readLog, type LogPosition } from '#store/log.ts'
import { TitanError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { privateDir } from '#store/storage.ts'
import type { Document, SearchSnapshot } from './model.ts'
import { TITAN_CARD } from '#titan/identity.ts'
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
const INDEX_VERSION = 10
const CATCH_UP_BATCH_EVENTS = 500
// The full-text index an earlier version kept beside each Titan.
const RETIRED_INDEX_FILES = [
  'search.db',
  'search.db-wal',
  'search.db-shm',
]
// Oracle indexes Othrys data only: cards, their events and notes, never agent transcripts.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY, pos INTEGER NOT NULL, n INTEGER NOT NULL, event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, card TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL,
  text TEXT NOT NULL, source TEXT NOT NULL, pos INTEGER NOT NULL, part INTEGER NOT NULL, UNIQUE(source, pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card_at ON docs(card, at);
CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(terms, stems, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_delete AFTER DELETE ON docs BEGIN
  DELETE FROM words WHERE rowid=old.id;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary USING fts5vocab(words, 'col');
`

interface Cursor {
  pos: number
  n: number
  event: string
}

export function openIndex({
  titanId,
  sources,
  positions,
}: {
  titanId: string
} & Pick<SearchSnapshot, 'sources' | 'positions'>) {
  const dir = titanDir({ titanId })
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
      titanId,
      sources,
      positions,
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
  titanId,
  sources,
  positions,
}: {
  db: DatabaseSync
  titanId: string
} & Pick<SearchSnapshot, 'sources' | 'positions'>) {
  const getCursor = db.prepare('SELECT pos, n, event FROM cursors WHERE source=?')
  const putCursor = db.prepare(`INSERT INTO cursors(source, pos, n, event)
    VALUES(:source, :pos, :n, :event)
    ON CONFLICT(source) DO UPDATE SET pos=:pos, n=:n, event=:event`)
  const insert = db.prepare(`INSERT INTO docs(card, kind, at, text, source, pos, part)
    VALUES(?, ?, ?, ?, ?, ?, ?)`)
  const putWords = db.prepare('INSERT INTO words(rowid, terms, stems) VALUES(?, ?, ?)')
  const deleteDocs = db.prepare('DELETE FROM docs WHERE source=?')
  const deleteCursor = db.prepare('DELETE FROM cursors WHERE source=?')
  const currentSources = new Set(sources.map(source => source.key))

  transaction({
    db,
    fn: () => {
      for (const row of db.prepare('SELECT source FROM cursors').all() as { source: string }[]) {
        if (!currentSources.has(row.source)) {
          deleteDocs.run(row.source)
          deleteCursor.run(row.source)
        }
      }
    },
  })

  for (const source of sources) {
    let cursor = getCursor.get(source.key) as unknown as Cursor | undefined
    const belongs = !cursor || (cursor.pos <= source.position.bytes
      && source.accepted.get(cursor.event)?.n === cursor.n)

    if (!belongs) {
      transaction({
        db,
        fn: () => {
          deleteDocs.run(source.key)
          deleteCursor.run(source.key)
        },
      })
      cursor = undefined
      log({
        level: 'warn',
        operation: 'oracle.rebuild',
        titanId,
        name: source.key,
        status: 'cursor does not belong to its native log',
      })
    }

    let after: LogPosition = {
      bytes: cursor?.pos ?? 0,
      n: cursor?.n ?? 0,
    }

    while (after.n < source.position.n) {
      let last = cursor?.event ?? ''
      transaction({
        db,
        fn: () => {
          const next = readLog({
            path: source.path,
            after,
            through: source.position,
            readOnly: true,
            limit: CATCH_UP_BATCH_EVENTS,
            accept: ({ entry }) => {
              last = entry.id
              const event = nativeEvent({
                entry,
                ids: positions,
                scope: source.scope,
              })

              if (!event || (source.key.startsWith('task:') && event.cardId !== source.scope)) {
                return
              }

              let part = 0

              for (const document of eventDocuments({ event })) {
                const words = tokens({ text: fold({ text: document.text }) })
                const inserted = insert.run(
                  document.card,
                  document.kind,
                  document.at,
                  document.text,
                  source.key,
                  entry.n,
                  part++,
                )
                putWords.run(
                  inserted.lastInsertRowid,
                  words.join(' '),
                  words.map(word => `s${inflection({ word })}`).join(' '),
                )
              }
            },
          })

          if (next.n <= after.n) {
            throw new TitanError({
              code: 'LOG_CORRUPT',
              message: 'native log ended before its acknowledged position',
            })
          }

          putCursor.run({
            source: source.key,
            pos: next.bytes,
            n: next.n,
            event: last,
          })
          after = next
        },
      })
    }
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
      card: card === TITAN_CARD ? '$all' : card,
      kind,
      at,
      text: body,
    }
  }
}

function* eventDocuments({ event }: { event: TitanEvent }): Generator<Document> {
  if (event.type === 'chat.message' || event.type === 'titan.memory' || event.type === 'titan.review') {
    return
  }

  if (event.type === 'titan.helper-finished') {
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
