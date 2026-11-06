import type { DatabaseSync } from 'node:sqlite'
import { HydraError } from '#store/errors.ts'
import { nearest, prefixed } from './fuzzy.ts'
import { openReader, searchPath } from './index.ts'
import type { Hit, Kind, Match, Query } from './model.ts'
import { queryTerms, termExpr, type Term } from './query.ts'

const NOTE_WEIGHT = 2
// A chunk's BM25 rank, lower is better, with notes weighted up.
const RANK = `bm25(docs_fts) * CASE d.kind WHEN 'note' THEN ${NOTE_WEIGHT} ELSE 1 END`

export const SNIPPETS = 3

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

  const db = openReader({ path: searchPath({ hydraId }) })

  try {
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
    `SELECT d.kind, d.at, snippet(docs_fts, 0, :startMark, :endMark, '…', 16) AS s FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
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
    })),
  }))

  return {
    hits,
    total: cards[0]?.total ?? 0,
    match: mode,
  }
}
