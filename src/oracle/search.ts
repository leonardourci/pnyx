import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import type { DatabaseSync } from 'node:sqlite'
import { HydraError } from '#store/errors.ts'
import { nearest, prefixed } from './fuzzy.ts'
import { openReader, searchPath } from './index.ts'
import type { Hit, Kind, Match, Query, Snippet } from './model.ts'
import { MATCH_END, MATCH_START, markedParts } from './snippet.ts'
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
  state,
}: {
  hydraId: string
  query: Query
  state?: HydraState
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

  const scopedQuery = Boolean(query.columns?.length || query.projects?.length || query.since)
  const scope = scopedQuery ? state ?? loadHydra({ hydraId }).state : undefined
  const hasCardFilters = Boolean(query.columns?.length || query.projects?.length)
  const eligible = scope && hasCardFilters ? Object.values(scope.cards).filter(card => {
    const inColumn = !query.columns?.length || query.columns.includes(card.column)
    const inProject = !query.projects?.length || query.projects.includes(card.project ?? '')

    return inColumn && inProject
  })
    .map(card => card.id) : null
  const cutoff = query.since
  const recent = scope && cutoff ? Object.values(scope.cards)
    .filter(card => Date.parse(card.updatedAt) >= Date.parse(cutoff))
    .map(card => card.id) : []

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
      eligible,
      recent,
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
        eligible,
        recent,
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
    eligible,
    recent,
    terms,
    mode,
  }: {
    db: DatabaseSync
    query: Query
    eligible: string[] | null
    recent: string[]
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
    eligible: eligible === null ? null : JSON.stringify(eligible),
    recent: JSON.stringify(recent),
    since: query.since ?? null,
  }
  const scoped = '(:eligible IS NULL OR c.id IN (SELECT value FROM json_each(:eligible))) AND (:since IS NULL OR c.id IN (SELECT value FROM json_each(:recent)) OR EXISTS (SELECT 1 FROM docs recent_doc WHERE recent_doc.card = c.id AND julianday(recent_doc.at) >= julianday(:since)))'
  const chunks = `SELECT d.id, d.card, ${RANK} AS rank FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid JOIN cards c ON c.id = d.card
    WHERE docs_fts MATCH :match AND (:kind IS NULL OR d.kind = :kind) AND (:workspace IS NULL OR c.workspace = :workspace) AND (:live = 0 OR c.live = 1) AND ${scoped}`
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
               WHERE (:workspace IS NULL OR c.workspace = :workspace) AND (:live = 0 OR c.live = 1) AND ${scoped} ORDER BY h.rank, c.n LIMIT :limit`,
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
        startMark: query.highlight === false ? '' : MATCH_START,
        endMark: query.highlight === false ? '' : MATCH_END,
        card: r.card,
        kind: query.kind ?? null,
        n: query.card ? query.limit : SNIPPETS,
      }) as {
        kind: Kind
        at: string
        s: string
      }[]
    ).map(t => {
      const text = query.highlight === false ? t.s : t.s.replace(
        /\s+/g,
        ' ',
      )
      const found: Snippet = {
        kind: t.kind,
        at: t.at || 'unknown',
        snippet: text.replaceAll(
          MATCH_START,
          '[',
        ).replaceAll(
          MATCH_END,
          ']',
        ),
      }

      if (query.highlight === true) {
        found.parts = markedParts({ text })
      }

      return found
    }),
  }))

  return {
    hits,
    total: cards[0]?.total ?? 0,
    match: mode,
  }
}
