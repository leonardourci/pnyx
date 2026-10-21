import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HydraError } from '../core/model.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { cardSessionId, liveTask, sessionId } from '../core/tasks.ts'
import { harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { hydraDir, loadHydra, privateDir, readEventsFrom, withWriter } from '../store/hydra-store.ts'
import { synonymGroup } from './synonyms.ts'
import { CHUNKER_VERSION, chunk, eventText, redact, transcriptMessages } from './text.ts'

// Bump when the tables change; the index rebuilds on mismatch.
export const SCHEMA_VERSION = 8
export const KINDS = [
  'event',
  'note',
  'transcript',
] as const
export type Kind = (typeof KINDS)[number]

const EVENTS = 'events'
const NOTE_WEIGHT = 2
// A chunk's BM25 rank, lower is better, with notes weighted up.
const RANK = `bm25(docs_fts) * CASE d.kind WHEN 'note' THEN ${NOTE_WEIGHT} ELSE 1 END`

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

function isCurrent({ db }: { db: DatabaseSync }): boolean {
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
    db.exec('PRAGMA busy_timeout = 5000')

    if (isCurrent({ db })) {
      return db
    }

    db.close()
    removeIndex({ path })
  }

  withWriter({
    hydraId,
    fn: ({ writer }) =>
      harvestTranscripts({
        writer,
        cardIds: Object.keys(writer.state.cards),
        at: new Date().toISOString(),
      }),
  })
  const db = new DatabaseSync(path)
  // Transcript text is as private as the transcripts.
  chmodSync(
    path,
    0o600,
  )
  db.exec('PRAGMA busy_timeout = 5000')
  // IF NOT EXISTS lets two first runs race to create the same file.
  db.exec(`BEGIN IMMEDIATE; ${SCHEMA}
    INSERT OR REPLACE INTO meta (key, value) VALUES ('index_schema_version', '${SCHEMA_VERSION}'), ('chunker_version', '${CHUNKER_VERSION}');
    COMMIT;`)

  return db
}

interface Cursor {
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

export interface IndexResult {
  events: number
  transcripts: number
  docs: number
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
        if (event.type === 'chat.message') {
          add({
            card: event.cardId,
            kind: 'transcript',
            source: EVENTS,
            pos: event.seq,
            at: event.at,
            text: event.data.text,
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

export interface Query {
  text: string
  kind?: Kind
  card?: string
  workspace?: string
  limit: number
  live?: boolean
  // Also return each snippet's docs.id, for semantic search to fuse entries by.
  withIds?: boolean
  highlight?: boolean
}

export const SNIPPETS = 3

export interface Snippet {
  kind: Kind
  at: string
  snippet: string
  id?: number
}

// lexical: the words as typed, stemmed and with synonyms; fuzzy: nothing matched
// that way, so words with typos or cut short matched the indexed words nearest them.
export type Match = 'lexical' | 'fuzzy'

export interface Hit {
  card: string
  title: string
  kind?: 'hydra'
  match: Match
  snippets: Snippet[]
}

const fold = ({ text }: { text: string }) => text.toLowerCase().normalize('NFD')
  .replace(
    /\p{M}/gu,
    '',
  )

// The distinct words of a text, folded, as typo matching looks them up. Words under
// three letters have no trigram; longer than 32 are mostly hashes and ids.
function words({ text }: { text: string }): Set<string> {
  return new Set((fold({ text }).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length >= 3 && w.length <= 32))
}

const quote = ({ phrase }: { phrase: string }) => `"${phrase.replace(
  /"/g,
  '""',
)}"`

const bare = ({ token }: { token: string }) => token.replace(
  /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
  '',
)

// One query word, or a synonym phrase, and what it may match: its synonym group,
// or the word itself. A trailing * matches the word as a prefix, and the indexed
// words starting with it, and skips synonyms and typos.
interface Term {
  alts: readonly string[]
  prefix: boolean
  typo: boolean
}

function queryTerms({ text }: { text: string }): Term[] {
  const tokens = text.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token))
  const terms: Term[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!

    if (token.endsWith('*')) {
      terms.push({
        alts: [
          token.slice(
            0,
            -1,
          ),
        ],
        prefix: true,
        typo: false,
      })
      continue
    }

    const pair = i + 1 < tokens.length ? synonymGroup.get(`${bare({ token })} ${bare({ token: tokens[i + 1]! })}`.toLowerCase()) : undefined

    if (pair) {
      i += 1
    }

    const group = pair ?? synonymGroup.get(bare({ token }).toLowerCase())
    terms.push(
      group
        ? {
          alts: group,
          prefix: false,
          typo: false,
        }
        : {
          alts: [token],
          prefix: false,
          typo: true,
        },
    )
  }

  return terms
}

// A term as an FTS5 expression, each phrase quoted so punctuation is never read as
// query syntax. A prefix term's first alternative is the prefix.
function termExpr({ term }: { term: Term }): string {
  const alts = term.alts.map((
    alt,
    i,
  ) => `${quote({ phrase: alt })}${term.prefix && i === 0 ? '*' : ''}`)

  return alts.length === 1 ? alts[0]! : `(${alts.join(' OR ')})`
}

export const ftsQuery = ({ text }: {
  text: string
}): string => queryTerms({
  text,
}).map(term => termExpr({ term }))
  .join(' AND ')

const trigrams = ({ word }: { word: string }) =>
  Array.from(
    {
      length: Math.max(
        word.length - 2,
        0,
      ),
    },
    (
      _,
      i,
    ) => word.slice(
      i,
      i + 3,
    ),
  )

// Trigram similarity of two words, padded so their first and last letters weigh in.
function similarity({
  a,
  b,
}: {
  a: string
  b: string
}): number {
  const x = new Set(trigrams({ word: ` ${a} ` }))
  const y = new Set(trigrams({ word: ` ${b} ` }))
  const shared = [...x].filter(t => y.has(t)).length

  return shared / (x.size + y.size - shared)
}

const SIMILAR = 0.4
const NEAREST = 5

function nearest({
  db,
  word,
}: {
  db: DatabaseSync
  word: string
}): string[] {
  const w = fold({ text: bare({ token: word }) })

  if (!/^[\p{L}\p{N}]{3,}$/u.test(w)) {
    return []
  }

  const candidates = db
    .prepare('SELECT term FROM terms_tri WHERE terms_tri MATCH ? ORDER BY rank LIMIT 200')
    .all(trigrams({ word: w }).map(phrase => quote({ phrase }))
      .join(' OR ')) as { term: string }[]

  return candidates
    .map(({ term }) => ({
      term,
      score: term.includes(w) && w.length >= 4 ? 1 : similarity({
        a: w,
        b: term,
      }),
    }))
    .filter(c => c.term !== w && c.score >= SIMILAR)
    .sort((
      a,
      b,
    ) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(
      0,
      NEAREST,
    )
    .map(c => c.term)
}

const PREFIXED = 50

// The indexed words starting with a prefix. FTS5 stems a prefix query ("retry"* looks
// for retri*), so a prefix also matches these words, each stemmed as the index stems it.
// ponytail: the first PREFIXED words in order; a short prefix may miss later ones.
function prefixed({
  db,
  prefix,
}: {
  db: DatabaseSync
  prefix: string
}): string[] {
  const p = fold({ text: bare({ token: prefix }) })

  if (!p) {
    return []
  }

  const rows = db.prepare('SELECT term FROM terms WHERE term >= ? AND term < ? ORDER BY term LIMIT ?').all(
    p,
    `${p}\u{10FFFF}`,
    PREFIXED,
  ) as { term: string }[]

  return rows.map(r => r.term).filter(term => term !== p)
}

// One hit per card, best first by BM25. Without --card or --kind every word must
// match somewhere on the card: its title, link titles, notes or any chunk, the
// title and link titles weighing half and the notes double; the snippets are its
// chunks matching the most words. With --card or --kind every word must match in one chunk of that card or kind.
// Words match stemmed, case and accent folded, and with their synonyms; when that
// finds nothing, words also match the indexed words nearest them.
export function search({
  hydraId,
  query,
}: {
  hydraId: string
  query: Query
}): {
  hits: Hit[]
  total: number
  match: Match
} {
  const typed = queryTerms({ text: query.text })

  if (!typed.length) {
    throw new HydraError({
      message: 'query has no words to search for',
      code: 'VALIDATION_ERROR',
      help: ['Run `pnyx-axi oracle "<words>"`'],
    })
  }

  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(
    searchPath({ hydraId }),
    { readOnly: true },
  )

  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const terms = typed.map(t => (
      t.prefix ? {
        ...t,
        alts: [
          ...t.alts,
          ...prefixed({
            db,
            prefix: t.alts[0]!,
          }),
        ],
      } : t
    ))
    const lexical = run({
      db,
      query,
      terms,
      mode: 'lexical',
    })

    if (lexical.hits.length) {
      return lexical
    }

    const fuzzy = terms.map(t => (
      t.typo ? {
        ...t,
        alts: [
          ...t.alts,
          ...nearest({
            db,
            word: t.alts[0]!,
          }),
        ],
      } : t
    ))

    return fuzzy.some((
      t,
      i,
    ) => t.alts.length !== terms[i]!.alts.length) ? run({
        db,
        query,
        terms: fuzzy,
        mode: 'fuzzy',
      }) : lexical
  } finally {
    db.close()
  }
}

function run(
  {
    db,
    query,
    terms,
    mode,
  }: {
    db: DatabaseSync
    query: Query
    terms: Term[]
    mode: Match
  },
): {
  hits: Hit[]
  total: number
  match: Match
} {
  const exprs = terms.map(term => termExpr({ term }))
  const match = exprs.join(' AND ')
  const filters = {
    match,
    workspace: query.workspace ?? null,
    live: query.live ? 1 : 0,
  }
  const chunks = `SELECT d.id, d.card, ${RANK} AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid JOIN cards c ON c.id = d.card
    WHERE docs_fts MATCH :match AND (:kind IS NULL OR d.kind = :kind) AND (:workspace IS NULL OR c.workspace = :workspace) AND (:live = 0 OR c.live = 1)`
  type Row = {
    card: string
    title: string
    total: number
  }
  const cards = (
    query.card
      ? db
        .prepare(`WITH h AS MATERIALIZED (${chunks} AND d.card = :card) SELECT h.card, c.title, count(*) AS total FROM h JOIN cards c ON c.id = h.card GROUP BY h.card`)
        .all({
          ...filters,
          kind: query.kind ?? null,
          card: query.card,
        })
      : query.kind
        ? db
          .prepare(
            `WITH h AS MATERIALIZED (${chunks}) SELECT h.card, c.title, count(*) OVER () AS total FROM h JOIN cards c ON c.id = h.card
               GROUP BY h.card ORDER BY min(h.rank), min(h.id) LIMIT :limit`,
          )
          .all({
            ...filters,
            kind: query.kind,
            limit: query.limit,
          })
        : db
          .prepare(
            `WITH h AS MATERIALIZED (SELECT rowid AS n, bm25(card_fts, 0.5, ${NOTE_WEIGHT}, 1.0) AS rank FROM card_fts WHERE card_fts MATCH :match)
               SELECT c.id AS card, c.title, count(*) OVER () AS total FROM h JOIN cards c ON c.n = h.n
               WHERE (:workspace IS NULL OR c.workspace = :workspace) AND (:live = 0 OR c.live = 1) ORDER BY h.rank, c.n LIMIT :limit`,
          )
          .all({
            ...filters,
            limit: query.limit,
          })
  ) as Row[]
  const top = db.prepare(
    `SELECT d.id, d.kind, d.at, snippet(docs_fts, 0, :startMark, :endMark, '…', 16) AS s FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
     WHERE docs_fts MATCH :match AND d.card = :card AND (:kind IS NULL OR d.kind = :kind) ORDER BY ${RANK}, d.id LIMIT :n`,
  )
  const snippetMatch = query.card || query.kind ? match : exprs.join(' OR ')
  const hits = cards.map(r => ({
    card: r.card,
    title: r.title,
    ...(r.card === '$board' ? { kind: 'hydra' as const } : {}),
    match: mode,
    snippets: (
      top.all({
        match: snippetMatch,
        startMark: query.highlight === false ? '' : '[',
        endMark: query.highlight === false ? '' : ']',
        card: r.card,
        kind: query.kind ?? null,
        n: query.card ? query.limit : SNIPPETS,
      }) as {
        id: number
        kind: Kind
        at: string
        s: string
      }[]
    ).map(t => ({
      kind: t.kind,
      at: t.at || 'unknown',
      snippet: query.highlight === false ? t.s : t.s.replace(
        /\s+/g,
        ' ',
      ),
      ...(query.withIds ? { id: t.id } : {}),
    })),
  }))

  return {
    hits,
    total: cards[0]?.total ?? 0,
    match: mode,
  }
}

export interface IndexStatus {
  builtThrough: number
  docs: Record<Kind, number>
  transcripts: {
    tracked: number
    missing: number
  }
  bytes: number
  current: boolean
}

// Reads the index without writing it. Null when it has not been built.
export function indexStatus({ hydraId }: { hydraId: string }): IndexStatus | null {
  const path = searchPath({ hydraId })

  if (!existsSync(path)) {
    return null
  }

  const { DatabaseSync } = sqlite()
  const db = new DatabaseSync(
    path,
    { readOnly: true },
  )

  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const bytes = statSync(path).size

    if (!isCurrent({ db })) {
      return {
        builtThrough: 0,
        docs: {
          event: 0,
          note: 0,
          transcript: 0,
        },
        transcripts: {
          tracked: 0,
          missing: 0,
        },
        bytes,
        current: false,
      }
    }

    const count = ({ kind }: { kind: Kind }) => (db.prepare('SELECT count(*) AS n FROM docs WHERE kind = ?').get(kind) as { n: number }).n
    const cursors = db.prepare('SELECT * FROM cursors').all() as unknown as Cursor[]
    const transcripts = cursors.filter(c => c.source !== EVENTS)

    return {
      builtThrough: cursors.find(c => c.source === EVENTS)?.seq ?? 0,
      docs: {
        event: count({ kind: 'event' }),
        note: count({ kind: 'note' }),
        transcript: count({ kind: 'transcript' }),
      },
      transcripts: {
        tracked: transcripts.length,
        missing: transcripts.filter(c => !existsSync(c.source)).length,
      },
      bytes,
      current: true,
    }
  } finally {
    db.close()
  }
}
