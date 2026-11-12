import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { liveTask } from '#tasks/select.ts'
import { HydraError } from '#store/errors.ts'
import type { Hit, Match, Query, Snippet } from './model.ts'
import { queryTerms, fold, tokens, type Term } from './query.ts'
import { documents, type Document } from './documents.ts'
import { redact } from './text.ts'
import { similarity } from './fuzzy.ts'

export const SNIPPETS = 3
const NOTE_WEIGHT = 2
const CONTEXT_WEIGHT = 0.5
const FUZZY_SIMILARITY = 0.4
const SNIPPET_CHARS = 180

const inflection = ({ word }: { word: string }) => word.replace(
  /(?:ing|ed|es|s)$/u,
  '',
)

function matches({
  word,
  term,
  fuzzy,
}: {
  word: string
  term: Term
  fuzzy: boolean
}): boolean {
  return term.alts.some(alt => {
    const alternative = fold({ text: alt })

    if (term.prefix) {
      return word.startsWith(alternative)
    }

    if (word === alternative || inflection({ word }) === inflection({ word: alternative })) {
      return true
    }

    if (!fuzzy || !term.typo || alternative.length < 3) {
      return false
    }

    const contains = alternative.length >= 4 && word.includes(alternative)
    const similar = similarity({
      a: word,
      b: alternative,
    }) >= FUZZY_SIMILARITY

    return contains || similar
  })
}

function wordMatches({
  text,
  term,
  fuzzy,
}: {
  text: string
  term: Term
  fuzzy: boolean
}): boolean {
  if (term.alts.some(alt => alt.includes(' '))) {
    const phrases = ` ${tokens({ text: fold({ text }) }).join(' ')} `

    return term.alts.some(alt => phrases.includes(` ${fold({ text: alt })}${term.prefix ? '' : ' '}`))
  }

  return tokens({ text: fold({ text }) }).some(word => matches({
    word,
    term,
    fuzzy,
  }))
}

function snippet({
  entry,
  terms,
  query,
  fuzzy,
}: {
  entry: Document
  terms: Term[]
  query: Query
  fuzzy: boolean
}): Snippet {
  const text = query.highlight === false ? entry.text : entry.text.replace(
    /\s+/g,
    ' ',
  )
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)]
  const marked = new Set<number>()

  for (const [
    index,
    found,
  ] of words.entries()) {
    if (terms.some(term => matches({
      word: fold({ text: found[0] }),
      term,
      fuzzy,
    }))) {
      marked.add(index)
    }

    for (const term of terms) {
      for (const alternative of term.alts) {
        const phrase = tokens({ text: fold({ text: alternative }) })

        if (phrase.length < 2 || index + phrase.length > words.length) {
          continue
        }

        const found = phrase.every((
          word,
          offset,
        ) => {
          const candidate = fold({ text: words[index + offset]![0] })

          if (term.prefix && offset === phrase.length - 1) {
            return candidate.startsWith(word)
          }

          return candidate === word
        })

        if (found) {
          phrase.forEach((
            _,
            offset,
          ) => marked.add(index + offset))
        }
      }
    }
  }

  const ranges = words.filter((
    _,
    index,
  ) => marked.has(index))
  const first = ranges[0]?.index ?? 0
  const start = Math.max(
    0,
    first - Math.floor(SNIPPET_CHARS / 3),
  )
  const end = Math.min(
    text.length,
    start + SNIPPET_CHARS,
  )
  const parts: {
    text: string
    matched: boolean
  }[] = []
  let through = start

  if (start > 0) {
    parts.push({
      text: '…',
      matched: false,
    })
  }

  for (const found of ranges) {
    if (found.index < start || found.index + found[0].length > end) {
      continue
    }

    if (found.index > through) {
      parts.push({
        text: text.slice(
          through,
          found.index,
        ),
        matched: false,
      })
    }

    parts.push({
      text: found[0],
      matched: true,
    })
    through = found.index + found[0].length
  }

  if (through < end) {
    parts.push({
      text: text.slice(
        through,
        end,
      ),
      matched: false,
    })
  }

  if (end < text.length) {
    parts.push({
      text: '…',
      matched: false,
    })
  }

  const result: Snippet = {
    kind: entry.kind,
    at: entry.at || 'unknown',
    snippet: parts.map(part => part.matched && query.highlight !== false ? `[${part.text}]` : part.text).join(''),
  }

  if (query.highlight === true) {
    result.parts = parts
  }

  return result
}

export function search({
  hydraId,
  query,
  state = loadHydra({ hydraId }).state,
}: {
  hydraId: string
  query: Query
  state?: HydraState
}): {
  hits: Hit[]
  total: number
  match: Match
} {
  const terms = queryTerms({ text: query.text })

  if (!terms.length) {
    throw new HydraError({
      message: 'query has no words to search for',
      code: 'VALIDATION_ERROR',
      help: ['Run `pnyx-axi oracle "<words>"`'],
    })
  }

  const run = ({ fuzzy }: { fuzzy: boolean }) => {
    const grouped = new Map<string, Document[]>()
    const newest = new Map<string, number>()

    for (const document of documents({
      hydraId,
      state,
    })) {
      const at = Date.parse(document.at)

      if (at > (newest.get(document.card) ?? 0)) {
        newest.set(
          document.card,
          at,
        )
      }

      if (!terms.some(term => wordMatches({
        text: document.text,
        term,
        fuzzy,
      }))) {
        continue
      }

      const entries = grouped.get(document.card)

      if (entries) {
        entries.push(document)
      } else {
        grouped.set(
          document.card,
          [document],
        )
      }
    }

    const mode: Match = fuzzy ? 'fuzzy' : 'lexical'
    const ranked: {
      hit: Hit
      score: number
    }[] = []
    const candidates = [
      ...Object.values(state.cards).filter(card => card.id !== '$hydra'),
      {
        id: '$board',
        title: 'Hydra',
        workspace: '',
        project: undefined,
        column: '',
        updatedAt: '',
        links: [],
      },
    ]

    for (const card of candidates) {
      if (query.card && query.card !== card.id) {
        continue
      }

      if (query.workspace && query.workspace !== card.workspace) {
        continue
      }

      if (query.live && card.id !== '$board' && !liveTask({ card: state.cards[card.id]! })) {
        continue
      }

      if (query.columns?.length && !query.columns.includes(card.column)) {
        continue
      }

      if (query.projects?.length && !query.projects.includes(card.project ?? '')) {
        continue
      }

      const entries = grouped.get(card.id) ?? []

      if (query.since) {
        const cutoff = Date.parse(query.since)
        const recentCard = Date.parse(card.updatedAt) >= cutoff
        const recentEntry = (newest.get(card.id) ?? 0) >= cutoff
        const recent = recentCard || recentEntry

        if (!recent) {
          continue
        }
      }

      const selected = entries.filter(entry => !query.kind || entry.kind === query.kind)
      const context = redact({
        text: [
          card.title,
          card.project,
          ...card.links.map(link => link.title),
        ].join(' '),
      })
      const scored = selected.map(entry => ({
        entry,
        found: terms.map(term => wordMatches({
          text: entry.text,
          term,
          fuzzy,
        })),
      }))
      const scoped = Boolean(query.kind || query.card)
      const found = terms.map((
        term,
        index,
      ) => !scoped && wordMatches({
        text: context,
        term,
        fuzzy,
      }) || scored.some(entry => entry.found[index]))

      if (!found.every(Boolean) || scoped && !scored.some(entry => entry.found.every(Boolean))) {
        continue
      }

      const snippets = scored.filter(entry => {
        return scoped ? entry.found.every(Boolean) : entry.found.some(Boolean)
      })
        .sort((
          a,
          b,
        ) => b.found.filter(Boolean).length * (b.entry.kind === 'note' ? NOTE_WEIGHT : 1) - a.found.filter(Boolean).length * (a.entry.kind === 'note' ? NOTE_WEIGHT : 1))
      const score = scored.reduce(
        (
          sum,
          entry,
        ) => sum + entry.found.filter(Boolean).length * (entry.entry.kind === 'note' ? NOTE_WEIGHT : 1),
        0,
      ) + terms.filter(term => wordMatches({
        text: context,
        term,
        fuzzy,
      })).length * CONTEXT_WEIGHT
      const hit: Hit = {
        card: card.id,
        title: card.title,
        match: mode,
        snippets: snippets.slice(
          0,
          query.card ? query.limit : SNIPPETS,
        ).map(({ entry }) => snippet({
          entry,
          terms,
          query,
          fuzzy,
        })),
      }

      if (card.id === '$board') {
        hit.kind = 'hydra'
      }

      ranked.push({
        hit,
        score,
      })
    }

    ranked.sort((
      a,
      b,
    ) => b.score - a.score)

    return {
      hits: ranked.slice(
        0,
        query.limit,
      ).map(entry => entry.hit),
      total: ranked.length,
      match: mode,
    }
  }

  const lexical = run({ fuzzy: false })

  return lexical.hits.length ? lexical : run({ fuzzy: true })
}
