import { chmodSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import type { HydraState } from '#app/model.ts'
import { hydraDir } from '#app/home-migration.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import { privateDir } from '#store/storage.ts'
import { cardSessionId, sessionId } from '#workers/session-attachments.ts'
import { transcriptMessages } from '#workers/transcripts.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import { documentChunks, eventDocuments, type Document } from './documents.ts'
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

const TRANSCRIPT_BATCH_BYTES = 256 * 1024
const EVENTS = 'events'
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY, card TEXT NOT NULL, session TEXT NOT NULL,
  identity TEXT NOT NULL, pos INTEGER NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archived (session TEXT NOT NULL, line TEXT NOT NULL, PRIMARY KEY(session, line));
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
  const path = searchPath({ hydraId })
  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(path)
  const newest = new Map<string, number>()

  try {
    chmodSync(
      path,
      0o600,
    )
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
    db.exec(SCHEMA)
    catchUp({
      db,
      hydraId,
      state,
    })
    const times = db.prepare('SELECT card, max((julianday(at) - 2440587.5) * 86400000) AS at FROM docs GROUP BY card').all() as {
      card: string
      at: number | null
    }[]

    for (const row of times) {
      newest.set(
        row.card,
        Math.round(row.at ?? 0),
      )
    }
  } catch (error) {
    db.close()
    throw error
  }

  return {
    newest,
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

  transaction({
    db,
    fn: () => {
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
      })
      const belongs = !cursor.event || state.eventIds[cursor.event] === cursor.seq

      if (!read || !belongs || (read.events.length && read.events[0]!.seq !== cursor.seq + 1)) {
        throw new HydraError({
          code: 'LOG_CORRUPT',
          message: 'Oracle cache cursor does not belong to this event log',
          help: [`Remove the derived cache ${searchPath({ hydraId })} and query again`],
        })
      }

      for (const event of read.events) {
        let session = ''
        let line = ''

        if (event.type === 'chat.message') {
          session = event.data.session
          const position = /^(\d+)(?::[mt]\d+(?:\.\d+)?)?$/.exec(event.data.nativeId)
          line = position ? position[1]! : event.data.nativeId
          db.prepare('INSERT OR IGNORE INTO archived VALUES(?, ?)').run(
            session,
            line,
          )
          db.prepare('DELETE FROM docs WHERE session=? AND line=? AND source<>?').run(
            session,
            line,
            EVENTS,
          )
          const replaced = event.data.replaces ? state.eventIds[event.data.replaces] : undefined

          if (replaced !== undefined) {
            db.prepare('DELETE FROM docs WHERE source=? AND pos=?').run(
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

    try {
      through = statSync(cursor.source).size
    } catch {
      // Native files may disappear; archived messages remain indexed.
      continue
    }

    let next = {
      ...cursor,
      card,
    }
    let pending = true

    while (pending) {
      pending = transaction({
        db,
        fn: () => {
          const tail = readTranscript({
            cursor: next,
            maxBytes: TRANSCRIPT_BATCH_BYTES,
            through,
          })

          if (!tail || (!tail.reset && tail.end === next.pos)) {
            return false
          }

          if (tail.reset) {
            db.prepare('DELETE FROM docs WHERE source=?').run(next.source)
          }

          for (const line of tail.lines) {
            if (db.prepare('SELECT 1 FROM archived WHERE session=? AND line=?').get(
              cursor.session,
              String(line.pos),
            )) {
              continue
            }

            let part = 0

            for (const message of transcriptMessages({ record: line.record })) {
              for (const entry of documentChunks({
                card,
                kind: 'transcript',
                at: message.at ?? '',
                text: message.text,
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

          return tail.end > 0
        },
      })
    }
  }
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
