import { transcriptMessages } from '#workers/transcripts.ts'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { liveTask } from '#tasks/select.ts'
import { cardSessionId, sessionId } from '#workers/session-attachments.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { privateDir } from '#store/storage.ts'
import type { IndexResult, Kind } from './model.ts'
import { words } from './query.ts'
import { CHUNKER_VERSION, chunk, eventText, redact, withoutInjected } from './text.ts'

// Bump when the tables change; the index rebuilds on mismatch.
export const SCHEMA_VERSION = 8

export const EVENTS = 'events'
const BUSY_TIMEOUT = 'PRAGMA busy_timeout = 5000'
// Readers keep answering during a catch-up, and a killed writer leaves no hot journal that blocks read-only opens.
const WAL = 'PRAGMA journal_mode = WAL'

// Chunks key by event seq or native line offset; session identity deduplicates copied messages.
// card_fts holds one row per card, keyed by cards.n: its title and link titles, its
// notes and all its other chunks, so the words of one query can match anywhere on a card. Both
// stem words (Porter) and fold case and accents, so "deploying" finds "deploy".
// terms holds every distinct word indexed, unstemmed and folded; terms_tri splits
// them into trigrams so a query word with a typo or cut short finds the real word.
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
  content_hash TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT -1,
  UNIQUE (source, pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card ON docs (card);
CREATE INDEX IF NOT EXISTS docs_line ON docs (session, line);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (body, content='docs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts (docs_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TABLE IF NOT EXISTS cards (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, workspace TEXT NOT NULL, context TEXT NOT NULL, live INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5 (context, notes, body, content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE VIRTUAL TABLE IF NOT EXISTS terms_tri USING fts5 (term, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS terms_ai AFTER INSERT ON terms BEGIN
  INSERT INTO terms_tri (term) VALUES (new.term);
END;
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, card TEXT NOT NULL, identity TEXT NOT NULL, pos INTEGER NOT NULL, seq INTEGER NOT NULL, session TEXT NOT NULL DEFAULT '');
`

const require = createRequire(import.meta.url)

// Node 22 prints an ExperimentalWarning to stderr when node:sqlite loads; it is the
// only experimental module Pnyx uses, so warnings are muted for that one load.
export function sqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning
  process.emitWarning = () => {}

  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

export const searchPath = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'search.db',
)

function removeIndex({ path }: { path: string }): void {
  for (const suffix of [
    '',
    '-journal',
    '-wal',
    '-shm',
  ]) {
    rmSync(
      `${path}${suffix}`,
      { force: true },
    )
  }
}

function metaValue({
  db,
  key,
}: {
  db: DatabaseSync
  key: string
}): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined

  return row?.value
}

export function isCurrent({ db }: { db: DatabaseSync }): boolean {
  try {
    return metaValue({
      db,
      key: 'index_schema_version',
    }) === String(SCHEMA_VERSION) && metaValue({
      db,
      key: 'chunker_version',
    }) === String(CHUNKER_VERSION)
  } catch {
    return false
  }
}

// Opens the index for writing, creating it, or deleting and recreating it when it
// was built by another schema or chunker version. A new index first harvests every
// card's transcript, so what a transcript holds as a note is a note before it is indexed.
// ponytail: a rebuild deletes the file under any concurrent reader; it reopens on its next query.
function openWriter(
  {
    hydraId,
    fresh = false,
  }: {
    hydraId: string
    fresh?: boolean
  },
): DatabaseSync {
  const { DatabaseSync } = sqlite()
  const path = searchPath({ hydraId })
  privateDir({ dir: hydraDir({ hydraId }) })

  if (fresh) {
    removeIndex({ path })
  }

  if (existsSync(path)) {
    const db = new DatabaseSync(path)
    db.exec(BUSY_TIMEOUT)

    if (isCurrent({ db })) {
      db.exec(WAL)

      return db
    }

    db.close()
    removeIndex({ path })
  }

  // The server harvests transcripts before it starts a build; this process writes only the search index.
  const db = new DatabaseSync(path)
  // Transcript text is as private as the transcripts.
  chmodSync(
    path,
    0o600,
  )
  db.exec(BUSY_TIMEOUT)
  db.exec(WAL)
  // IF NOT EXISTS lets two first runs race to create the same file.
  db.exec(`BEGIN IMMEDIATE; ${SCHEMA}
    INSERT OR REPLACE INTO meta (key, value) VALUES ('index_schema_version', '${SCHEMA_VERSION}'), ('chunker_version', '${CHUNKER_VERSION}');
    COMMIT;`)

  return db
}

export function openReader({ path }: { path: string }): DatabaseSync {
  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(
    path,
    { readOnly: true },
  )
  db.exec(BUSY_TIMEOUT)

  return db
}

export interface Cursor {
  source: string
  card: string
  identity: string
  pos: number
  seq: number
  session: string
}

function transaction<T>({
  db,
  fn,
}: {
  db: DatabaseSync
  fn: () => T
}): T {
  db.exec('BEGIN IMMEDIATE')

  try {
    const result = fn()
    db.exec('COMMIT')

    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Folds what the log and the recorded transcripts gained since the cursors into
// the index, in one transaction. SQLite's write lock keeps two indexers apart.
function catchUp({
  db,
  hydraId,
}: {
  db: DatabaseSync
  hydraId: string
}): IndexResult {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO docs (card, kind, source, pos, part, at, body, content_hash, session, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const archived = db.prepare('SELECT 1 FROM docs WHERE session = ? AND line = ? AND source = ? LIMIT 1')
  const nativeCopies = db.prepare('SELECT id, card FROM docs WHERE session = ? AND line = ? AND source <> ?')
  const dropDoc = db.prepare('DELETE FROM docs WHERE id = ?')
  // Cards whose card_fts row no longer matches their chunks, title or link titles.
  const dirty = new Set<string>()
  // ponytail: words of dropped chunks stay in terms; a typo may expand to a word that no longer matches.
  const putTerm = db.prepare('INSERT OR IGNORE INTO terms (term) VALUES (?)')
  const seen = new Set<string>()

  const addTerms = ({ text }: { text: string }) => {
    for (const term of words({ text })) {
      if (seen.has(term)) {
        continue
      }

      seen.add(term)
      putTerm.run(term)
    }
  }

  let docs = 0

  const add = (
    {
      card,
      kind,
      source,
      pos,
      at,
      text,
      firstPart = 0,
      session = '',
      line = -1,
    }: {
      card: string
      kind: Kind
      source: string
      pos: number
      at: string
      text: string
      firstPart?: number
      session?: string
      line?: number
    },
  ): number => {
    card = card === HYDRA_CARD ? '$board' : card
    let part = firstPart

    if (session && source !== EVENTS && archived.get(
      session,
      line,
      EVENTS,
    )) {
      return part
    }

    if (session && source === EVENTS) {
      const copies = nativeCopies.all(
        session,
        line,
        EVENTS,
      ) as {
        id: number
        card: string
      }[]

      for (const copy of copies) {
        dropDoc.run(copy.id)
        dirty.add(copy.card)
      }
    }

    for (const body of chunk({ text: redact({ text }) })) {
      const hash = createHash('sha256').update(body)
        .digest('hex')
      const row = [
        card,
        kind,
        source,
        pos,
        part,
        at,
        body,
        hash,
        session,
        line,
      ] as const
      const changes = Number(insert.run(...row).changes)

      if (changes) {
        dirty.add(card)
        addTerms({ text: body })
      }

      docs += changes
      part += 1
    }

    return part
  }

  const getCursor = db.prepare('SELECT * FROM cursors WHERE source = ?')
  const putCursor = db.prepare(
    'INSERT INTO cursors (source, card, identity, pos, seq, session) VALUES (:source, :card, :identity, :pos, :seq, :session) ' +
      'ON CONFLICT (source) DO UPDATE SET identity = :identity, pos = :pos, seq = :seq',
  )
  const track = db.prepare("INSERT OR IGNORE INTO cursors (source, card, identity, pos, seq, session) VALUES (?, ?, '', 0, 0, ?)")

  return transaction({
    db,
    fn: () => {
      let cursor = (getCursor.get(EVENTS) as Cursor | undefined) ?? {
        source: EVENTS,
        card: '',
        identity: '',
        pos: 0,
        seq: 0,
        session: '',
      }
      let read = readEventsFrom({
        hydraId,
        offset: cursor.pos,
      })

      // The log never shrinks or reorders, so a mismatch means the index is from another log: start over.
      if (!read || (read.events.length > 0 && read.events[0]!.seq !== cursor.seq + 1)) {
        db.exec('DELETE FROM docs; DELETE FROM cursors; DELETE FROM cards; DELETE FROM card_fts; DELETE FROM terms; DELETE FROM terms_tri;')
        cursor = {
          ...cursor,
          pos: 0,
          seq: 0,
        }
        read = readEventsFrom({
          hydraId,
          offset: 0,
        })!
      }

      for (const event of read.events) {
        if (event.type === 'hydra.helper-finished') {
          let part = 0

          for (const outcome of event.data.outcomes) {
            // Handled results already have a routine chat message; unchanged waits carry no new result.
            if (outcome.status === 'handled' || outcome.status === 'still_waiting') {
              continue
            }

            part = add({
              card: outcome.task,
              kind: 'event',
              source: EVENTS,
              pos: event.seq,
              at: event.at,
              text: outcome.summary,
              firstPart: part,
            })
          }
        } else if (event.type === 'chat.message') {
          add({
            card: event.cardId,
            kind: 'transcript',
            source: EVENTS,
            pos: event.seq,
            at: event.at,
            text: withoutInjected({ text: event.data.text }),
            session: event.data.session,
            line: Number.parseInt(event.data.nativeId),
          })
        } else if (event.type === 'card.noted') {
          add({
            card: event.cardId,
            kind: 'note',
            source: EVENTS,
            pos: event.seq,
            at: event.data.at ?? event.at,
            text: eventText({ event }),
          })
        } else {
          add({
            card: event.cardId,
            kind: 'event',
            source: EVENTS,
            pos: event.seq,
            at: event.at,
            text: eventText({ event }),
          })
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
      })

      const state = loadHydra({ hydraId }).state
      const hydra = state.cards[HYDRA_CARD]
      const hydraSession = hydra ? cardSessionId({ card: hydra }) : undefined
      let transcripts = 0
      const dropSource = db.prepare('DELETE FROM docs WHERE source = ?')

      for (const t of db.prepare('SELECT * FROM cursors WHERE source <> ?').all(EVENTS) as unknown as Cursor[]) {
        const target = t.card === HYDRA_CARD || (hydraSession && t.session === hydraSession) ? '$board' : t.card

        if (target !== t.card) {
          db.prepare('UPDATE docs SET card = ? WHERE source = ?').run(
            target,
            t.source,
          )
          dirty.add(t.card); dirty.add(target)
        }

        const tail = readTranscript({ cursor: t })

        if (!tail) {
          continue
        }

        if (tail.reset && Number(dropSource.run(t.source).changes)) {
          dirty.add(target)
        }

        for (const line of tail.lines) {
          let part = 0

          for (const m of transcriptMessages({ record: line.record })) {
            part = add({
              card: target,
              kind: 'transcript',
              source: t.source,
              pos: line.pos,
              at: m.at ?? '',
              text: m.text,
              firstPart: part,
              session: t.session,
              line: line.pos,
            })
          }
        }

        putCursor.run({
          ...t,
          identity: tail.identity,
          pos: tail.end,
          seq: 0,
        })
        transcripts += tail.lines.length > 0 ? 1 : 0
      }

      const getContext = db.prepare('SELECT context FROM cards WHERE id = ?')
      const putCard = db.prepare(
        'INSERT INTO cards (id, title, workspace, context, live) VALUES (:id, :title, :workspace, :context, :live) ' +
        'ON CONFLICT (id) DO UPDATE SET title = :title, workspace = :workspace, context = :context, live = :live',
      )

      const targets = [
        ...Object.values(state.cards).filter(card => card.id !== HYDRA_CARD)
          .map(card => ({
            ...card,
            live: liveTask({ card }) ? 1 : 0,
          })),
        {
          id: '$board',
          title: 'Hydra',
          workspace: '',
          links: [],
          live: 1,
          project: undefined,
        },
      ]

      for (const card of targets) {
        const context = card.id === '$board' ? '' : redact({
          text: [
            card.title,
            card.project,
            ...card.links.map(l => l.title),
          ].filter(Boolean).join('\n'),
        })

        if ((getContext.get(card.id) as { context: string } | undefined)?.context !== context) {
          dirty.add(card.id)
          addTerms({ text: context })
        }

        putCard.run({
          id: card.id,
          title: card.title,
          workspace: card.workspace,
          context,
          live: card.live,
        })
      }

      const getCard = db.prepare('SELECT n, context FROM cards WHERE id = ?')
      const cardBody = db.prepare(
        "SELECT coalesce(group_concat(body, char(10)), '') AS body FROM (SELECT body FROM docs WHERE card = ? AND (kind = 'note') = ? ORDER BY id)",
      )
      const dropCard = db.prepare('DELETE FROM card_fts WHERE rowid = ?')
      const putCardText = db.prepare('INSERT INTO card_fts (rowid, context, notes, body) VALUES (?, ?, ?, ?)')

      for (const id of dirty) {
        const card = getCard.get(id) as {
          n: number
          context: string
        } | undefined

        if (!card) {
          continue
        }

        dropCard.run(BigInt(card.n))
        const text = ({ notes }: {
          notes: boolean
        }) =>
          (cardBody.get(
            id,
            notes ? 1 : 0,
          ) as {
            body: string
          }).body
        putCardText.run(
          BigInt(card.n),
          card.context,
          text({ notes: true }),
          text({ notes: false }),
        )
      }

      return {
        events: read.events.length,
        transcripts,
        docs,
      }
    },
  })
}

export interface TranscriptRead {
  identity: string
  // The cursor no longer fits the file: drop what was indexed from it and read it again.
  reset: boolean
  lines: {
    pos: number
    record: unknown
  }[]
  end: number
}

// Complete JSONL lines after the cursor. A replaced file (another device and
// inode) or one shorter than the cursor is read again from the start. Null when
// the file is missing or unreadable, so the cursor waits for it.
// ponytail: reads the unread tail in one buffer; stream it if transcripts grow past memory.
export function readTranscript({ cursor }: { cursor: Pick<Cursor, 'source' | 'identity' | 'pos'> }): TranscriptRead | null {
  let fd: number

  try {
    fd = openSync(
      cursor.source,
      'r',
    )
  } catch {
    return null
  }

  try {
    const stat = fstatSync(fd)
    const identity = `${stat.dev}:${stat.ino}`
    const reset = (cursor.identity !== '' && cursor.identity !== identity) || stat.size < cursor.pos
    const from = reset ? 0 : cursor.pos
    const buf = Buffer.alloc(stat.size - from)
    readSync(
      fd,
      buf,
      0,
      buf.length,
      from,
    )
    const complete = buf.lastIndexOf(10) + 1
    const lines: TranscriptRead['lines'] = []

    for (let start = 0; start < complete; ) {
      const end = buf.indexOf(
        10,
        start,
      )

      try {
        lines.push({
          pos: from + start,
          record: JSON.parse(buf.toString(
            'utf8',
            start,
            end,
          )),
        })
      } catch {
        // Not JSON: nothing to index on this line.
      }

      start = end + 1
    }

    return {
      identity,
      reset,
      lines,
      end: from + complete,
    }
  } finally {
    closeSync(fd)
  }
}

export function updateIndex({ hydraId }: { hydraId: string }): IndexResult {
  const db = openWriter({ hydraId })

  try {
    return catchUp({
      db,
      hydraId,
    })
  } finally {
    db.close()
  }
}

export function rebuildIndex({ hydraId }: { hydraId: string }): IndexResult {
  const db = openWriter({
    hydraId,
    fresh: true,
  })

  try {
    return catchUp({
      db,
      hydraId,
    })
  } finally {
    db.close()
  }
}
