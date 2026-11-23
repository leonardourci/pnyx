import { taskProjectGroup } from '#tasks/order.ts'
import { ownerMemory } from '#memory/owner-memory.ts'
import { OWNER_DOCUMENTS } from '#memory/budgets.ts'
import { liveTask } from '#tasks/select.ts'
import { HydraError } from '#store/errors.ts'
import type { Document, Hit, Match, Query, SearchSnapshot, Snippet } from './model.ts'
import { queryTerms, fold, tokens, matches, type Term } from './query.ts'
import { openIndex } from './index.ts'
import { redact } from './text.ts'

const SNIPPETS = 3
const NOTE_WEIGHT = 2
// A term in the card's title, project or link titles outweighs that term in any one entry, so the
// card a query names ranks above cards that only mention it, however long their history.
const CONTEXT_WEIGHT = NOTE_WEIGHT + 1
const SNIPPET_CHARS = 180

const count = ({ found }: { found: boolean[] }) => found.filter(Boolean).length

const entryWeight = ({
  entry,
  found,
}: {
  entry: Document
  found: boolean[]
}) => count({ found }) * (entry.kind === 'note' ? NOTE_WEIGHT : 1)

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
  const text = entry.text.replace(
    /\s+/g,
    ' ',
  )
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)]
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
    snippet: parts.map(part => part.matched ? `[${part.text}]` : part.text).join(''),
  }

  if (query.includeParts) {
    result.parts = parts
  }

  return result
}

export function search({
  hydraId,
  query,
  memoryDocuments,
  state,
  sources,
  positions,
}: {
  hydraId: string
  query: Query
  memoryDocuments: Document[]
} & SearchSnapshot): {
  hits: Hit[]
  total: number
  match: Match
} {
  const terms = queryTerms({ text: query.text })

  if (!terms.length) {
    throw new HydraError({
      message: 'query has no words to search for',
      code: 'VALIDATION_ERROR',
      help: ['Run `pnyx oracle "<words>"`'],
    })
  }

  const ownerDocuments = Object.values(ownerMemory({
    migrate: false,
  })).map(entry => ({
    card: '$board',
    kind: 'note' as const,
    at: entry.at,
    text: redact({ text: entry.text }),
  }))
  const projectDocuments = memoryDocuments.map(document => ({
    ...document,
    text: redact({ text: document.text }),
  }))
  const hydraDocuments = Object.entries(state.hydraMemory ?? {})
    .filter(([key]) => !Object.hasOwn(
      OWNER_DOCUMENTS,
      key,
    ))
    .map(([
      key,
      entry,
    ]) => ({
      card: '$board',
      kind: 'event' as const,
      at: entry.at,
      text: redact({ text: `${key}: ${entry.text}` }),
    }))
  const index = openIndex({
    hydraId,
    sources,
    positions,
  })

  const run = ({ fuzzy }: { fuzzy: boolean }) => {
    const grouped = new Map<string, Document[]>()

    function* documents() {
      yield* index.documents({
        terms,
        fuzzy,
      })
      yield* ownerDocuments
      yield* projectDocuments
      yield* hydraDocuments
    }

    for (const document of documents()) {
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
      latest: number
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

      if (query.columns?.length) {
        const group = card.id === '$board' ? undefined : taskProjectGroup({
          state,
          card,
        })

        if (group === undefined || !query.columns.includes(group)) {
          continue
        }
      }

      if (query.projects?.length && card.id !== '$board' && !query.projects.includes(card.project ?? '')) {
        continue
      }

      let entries = grouped.get(card.id) ?? []

      if (card.id === '$board' && query.projects?.length) {
        const projects = new Set(query.projects)
        entries = entries.filter(entry => {
          if (entry.project === undefined) {
            return false
          }

          return projects.has(entry.project)
        })
      }

      if (query.since) {
        const cutoff = Date.parse(query.since)
        const recentCard = Date.parse(card.updatedAt) >= cutoff
        const recent = recentCard || index.newestAt({
          card: card.id,
        }) >= cutoff
          || entries.some(entry => Date.parse(entry.at) >= cutoff)

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
      const contextFound = terms.map(term => wordMatches({
        text: context,
        term,
        fuzzy,
      }))
      const scored = selected.map(entry => ({
        entry,
        found: terms.map(term => wordMatches({
          text: entry.text,
          term,
          fuzzy,
        })),
      }))
      const projectMemory = card.id === '$board' && Boolean(query.projects?.length)
      const scoped = Boolean(query.kind || query.card || projectMemory)
      const everyTermFound = terms.every((
        _,
        index,
      ) => {
        const inContext = !scoped && contextFound[index]!

        return inContext || scored.some(entry => entry.found[index])
      })
      const scopedMatch = scored.some(entry => entry.found.every(Boolean))

      if (!everyTermFound || scoped && !scopedMatch) {
        continue
      }

      const snippets = scored.filter(entry => {
        return scoped ? entry.found.every(Boolean) : entry.found.some(Boolean)
      })
        .sort((
          a,
          b,
        ) => entryWeight(b) - entryWeight(a))
      const bestEntry = snippets[0] ? entryWeight(snippets[0]) : 0
      const score = count({ found: contextFound }) * CONTEXT_WEIGHT + bestEntry
      // A spread of every entry would exceed the argument limit on a long history.
      const latest = snippets.reduce(
        (
          newest,
          { entry },
        ) => Math.max(
          newest,
          Date.parse(entry.at) || 0,
        ),
        Date.parse(card.updatedAt) || 0,
      )
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
        latest,
      })
    }

    ranked.sort((
      a,
      b,
    ) => b.score - a.score || b.latest - a.latest)

    return {
      hits: ranked.slice(
        0,
        query.limit,
      ).map(entry => entry.hit),
      total: ranked.length,
      match: mode,
    }
  }

  try {
    const lexical = run({ fuzzy: false })

    return lexical.hits.length ? lexical : run({ fuzzy: true })
  } finally {
    index.close()
  }
}
