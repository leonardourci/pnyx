import { chmodSync, existsSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import type { HydraState } from '#app/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import { log } from '#app/diagnostics.ts'
import { logPath, privateDir } from '#store/storage.ts'
import { cardSessionId, sessionId } from '#workers/session-attachments.ts'
import { recordEntries } from '#hydra/transcripts-read.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import { documentChunks, eventDocuments, type Document } from './documents.ts'
import { fold, inflection, matches, tokens, type Term } from './query.ts'
import { visibleText } from './text.ts'

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
const INDEX_VERSION = 3
const CATCH_UP_BATCH_BYTES = 256 * 1024
const EVENTS = 'events'
// The full-text index an earlier version kept beside each Hydra.
const RETIRED_INDEX_FILES = [
  'search.db',
  'search.db-wal',
  'search.db-shm',
]
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY, card TEXT NOT NULL, session TEXT NOT NULL,
  identity TEXT NOT NULL, pos INTEGER NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archived (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session TEXT NOT NULL, digest TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archived_text ON archived(session, digest);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, card TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL, pos INTEGER NOT NULL, part INTEGER NOT NULL,
  session TEXT NOT NULL, line TEXT NOT NULL, UNIQUE(source, pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card_at ON docs(card, at);
CREATE INDEX IF NOT EXISTS docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS docs_session_line ON docs(session, line);
CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(terms, stems, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_delete AFTER DELETE ON docs BEGIN
  DELETE FROM words WHERE rowid=old.id;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary USING fts5vocab(words, 'col');
`

interface Cursor {
  source: string
  card: string
  session: string
  identity: string
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
  const putCursor = db.prepare(`INSERT INTO cursors(source, card, session, identity, pos, seq, event)
    VALUES(:source, :card, :session, :identity, :pos, :seq, :event)
    ON CONFLICT(source) DO UPDATE SET card=:card, session=:session, identity=:identity, pos=:pos, seq=:seq, event=:event`)
  const track = db.prepare("INSERT OR IGNORE INTO cursors VALUES(?, ?, ?, '', 0, 0, '')")
  const insert = db.prepare('INSERT INTO docs(card, kind, at, text, source, pos, part, session, line) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const putWords = db.prepare('INSERT INTO words(rowid, terms, stems) VALUES(?, ?, ?)')
  const archive = db.prepare('INSERT OR IGNORE INTO archived VALUES(?, ?, ?, ?)')
  const archived = db.prepare('SELECT 1 FROM archived WHERE session=? AND digest=?')
  const predecessor = db.prepare('SELECT seq FROM archived WHERE id=?')
  const removeNative = db.prepare('DELETE FROM docs WHERE session=? AND line=? AND source<>?')
  const removeEvent = db.prepare('DELETE FROM docs WHERE source=? AND pos=?')

  const add = ({
    entry,
    source,
    pos,
    part,
    session = '',
    line = '',
  }: {
    entry: Document
    source: string
    pos: number
    part: number
    session?: string
    line?: string
  }) => {
    const words = tokens({ text: fold({ text: entry.text }) })
    const inserted = insert.run(
      entry.card,
      entry.kind,
      entry.at,
      entry.text,
      source,
      pos,
      part,
      session,
      line,
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
      card: '',
      session: '',
      identity: '',
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
          let session = ''
          let line = ''

          if (event.type === 'chat.message') {
            session = event.data.session
            const position = /^(\d+)(?::[mt]\d+(?:\.\d+)?)?$/.exec(event.data.nativeId)
            line = position ? position[1]! : event.data.nativeId

            if ((event.data.kind ?? 'message') === 'message') {
              archive.run(
                event.id,
                event.seq,
                session,
                textDigest({ text: event.data.text }),
              )
            }

            removeNative.run(
              session,
              line,
              EVENTS,
            )
            let replaced: number | undefined

            if (event.data.replaces) {
              replaced = state.eventIds[event.data.replaces]

              if (replaced === undefined) {
                const known = predecessor.get(event.data.replaces) as { seq: number } | undefined
                replaced = known?.seq
              }
            }

            if (replaced !== undefined) {
              removeEvent.run(
                EVENTS,
                replaced,
              )
            }
          }

          let part = 0

          for (const entry of eventDocuments({ event })) {
            add({
              entry,
              source: EVENTS,
              pos: event.seq,
              part,
              session,
              line,
            })
            part++
          }

          const agent = event.type === 'card.pushed' ? event.data.agent : undefined
          const path = agent?.transcriptPath

          if (agent && path && isAbsolute(path) && path.endsWith('.jsonl')) {
            track.run(
              path,
              event.cardId,
              sessionId({ agent }),
            )
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

  const hydra = state.cards[HYDRA_CARD]
  const hydraSession = hydra && cardSessionId({ card: hydra })

  for (const cursor of db.prepare('SELECT * FROM cursors WHERE source<>?').all(EVENTS) as unknown as Cursor[]) {
    const current = state.sessions?.[cursor.session]?.taskId ?? cursor.card
    const card = current === HYDRA_CARD || cursor.session === hydraSession ? '$board' : current

    if (cursor.card !== card) {
      transaction({
        db,
        fn: () => {
          db.prepare('UPDATE docs SET card=? WHERE source=?').run(
            card,
            cursor.source,
          )
          putCursor.run({
            ...cursor,
            card,
          })
        },
      })
    }

    let through: number
    let identity: string

    try {
      const stat = statSync(cursor.source)
      through = stat.size
      identity = `${stat.dev}:${stat.ino}`
    } catch {
      // Native files may disappear; archived messages remain indexed.
      continue
    }

    const sameSource = cursor.identity === '' || cursor.identity === identity

    if (cursor.pos === through && sameSource) {
      continue
    }

    let next = {
      ...cursor,
      card,
    }
    let pending = true
    let firstBatch = true

    while (pending) {
      pending = transaction({
        db,
        fn: () => {
          const committed = getCursor.get(next.source) as unknown as Cursor

          if (committed.pos !== next.pos || committed.identity !== next.identity) {
            next = {
              ...committed,
              card,
            }
            firstBatch = false

            return true
          }

          const tail = readTranscript({
            cursor: next,
            maxBytes: CATCH_UP_BATCH_BYTES,
            through,
          })

          if (!tail || (!tail.reset && tail.end === next.pos)) {
            return false
          }

          if (tail.reset && !firstBatch) {
            return false
          }

          firstBatch = false

          if (tail.reset) {
            db.prepare('DELETE FROM docs WHERE source=?').run(next.source)
          }

          for (const line of tail.lines) {
            let part = 0

            for (const message of recordEntries({
              record: line.record,
              offset: line.pos,
              tools: false,
              thinking: false,
            })) {
              if (message.kind !== 'message' || message.hidden || archived.get(
                cursor.session,
                textDigest({ text: message.text }),
              )) {
                continue
              }

              for (const entry of documentChunks({
                card,
                kind: 'transcript',
                at: message.at ?? '',
                text: visibleText({ text: message.text }),
              })) {
                add({
                  entry,
                  source: cursor.source,
                  pos: line.pos,
                  part,
                  session: cursor.session,
                  line: String(line.pos),
                })
                part++
              }
            }
          }

          next = {
            ...next,
            identity: tail.identity,
            pos: tail.end,
          }
          putCursor.run(next)

          return tail.end < through
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

function textDigest({ text }: { text: string }) {
  return createHash('sha256').update(text)
    .digest('hex')
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
