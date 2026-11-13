import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { readEventsFrom } from '#app/event-log.ts'
import { privateDir } from '#store/storage.ts'
import type { IndexResult, Kind } from './model.ts'
import { words } from './query.ts'
import { CHUNKER_VERSION, chunk, eventText, redact } from './text.ts'

// Bump when the tables change; the index rebuilds on mismatch.
export const SCHEMA_VERSION = 9

export const EVENTS = 'events'
const BUSY_TIMEOUT = 'PRAGMA busy_timeout = 5000'
// Readers keep answering during a catch-up, and a killed writer leaves no hot journal that blocks read-only opens.
const WAL = 'PRAGMA journal_mode = WAL'

// Chunks key by event seq.
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
  UNIQUE (source, pos, part)
);
CREATE INDEX IF NOT EXISTS docs_card ON docs (card);
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
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, pos INTEGER NOT NULL, seq INTEGER NOT NULL);
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
// was built by another schema or chunker version.
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

  const db = new DatabaseSync(path)
  // Task text is as private as the Hydra's log.
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

interface Cursor {
  source: string
  pos: number
  seq: number
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

// Folds what the log gained since the cursor into the index, in one transaction. SQLite's write lock keeps two indexers apart.
function catchUp({
  db,
  hydraId,
}: {
  db: DatabaseSync
  hydraId: string
}): IndexResult {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO docs (card, kind, source, pos, part, at, body, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const state = loadHydra({ hydraId }).state
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
      pos,
      at,
      text,
      firstPart = 0,
    }: {
      card: string
      kind: Kind
      pos: number
      at: string
      text: string
      firstPart?: number
    },
  ): number => {
    card = card === HYDRA_CARD ? '$board' : card
    let part = firstPart

    for (const body of chunk({ text: redact({ text }) })) {
      const hash = createHash('sha256').update(body)
        .digest('hex')
      const row = [
        card,
        kind,
        EVENTS,
        pos,
        part,
        at,
        body,
        hash,
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
    'INSERT INTO cursors (source, pos, seq) VALUES (:source, :pos, :seq) ON CONFLICT (source) DO UPDATE SET pos = :pos, seq = :seq',
  )

  return transaction({
    db,
    fn: () => {
      let cursor = (getCursor.get(EVENTS) as Cursor | undefined) ?? {
        source: EVENTS,
        pos: 0,
        seq: 0,
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
        // Agent transcripts are not Pnyx data: Oracle indexes tasks, events and notes only.
        if (event.type === 'chat.message') {
          continue
        }

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
              pos: event.seq,
              at: event.at,
              text: outcome.summary,
              firstPart: part,
            })
          }
        } else if (event.type === 'card.noted') {
          add({
            card: event.cardId,
            kind: 'note',
            pos: event.seq,
            at: event.data.at ?? event.at,
            text: eventText({ event }),
          })
        } else {
          add({
            card: event.cardId,
            kind: 'event',
            pos: event.seq,
            at: event.at,
            text: eventText({ event }),
          })
        }
      }

      putCursor.run({
        ...cursor,
        pos: read.end,
        seq: read.events.at(-1)?.seq ?? cursor.seq,
      })

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
export function readTranscript({
  cursor,
  through,
  maxBytes,
}: {
  cursor: {
    source: string
    identity: string
    pos: number
  }
  through?: number
  maxBytes?: number
}): TranscriptRead | null {
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
    const admittedEnd = through ?? stat.size
    const available = Math.max(
      0,
      Math.min(
        stat.size,
        admittedEnd,
      ) - from,
    )
    let buf = Buffer.alloc(Math.min(
      available,
      maxBytes ?? available,
    ))
    readSync(
      fd,
      buf,
      0,
      buf.length,
      from,
    )

    // A batch can exceed its byte budget only to finish its first native record.
    while (!buf.includes(10) && buf.length < available) {
      buf = Buffer.alloc(Math.min(
        available,
        Math.max(
          1,
          buf.length * 2,
        ),
      ))
      readSync(
        fd,
        buf,
        0,
        buf.length,
        from,
      )
    }

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
