import type { DatabaseSync } from 'node:sqlite'
import { bare, fold, quote } from './query.ts'

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

export function nearest({
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
export function prefixed({
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
