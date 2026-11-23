interface Letter {
  value: string
  from: number
  to: number
  wordStart: boolean
}

interface MatchStep {
  letter: Letter
  start: number
  wordStarts: number
  previous?: MatchStep
}

export interface SuggestionMatch {
  ranges: {
    from: number
    to: number
  }[]
  prefix: boolean
  gaps: number
  wordStarts: number
}

function letters({ text }: { text: string }): Letter[] {
  const result: Letter[] = []
  let offset = 0
  let wordStart = true

  for (const character of text) {
    const from = offset
    offset += character.length
    const values = [
      ...character.toLowerCase().replace(
        /ς/gu,
        'σ',
      ),
    ].filter(value => /[\p{L}\p{N}]/u.test(value))

    for (const value of values) {
      result.push({
        value,
        from,
        to: offset,
        wordStart,
      })
      wordStart = false
    }

    if (!values.length) {
      wordStart = true
    }
  }

  return result
}

function matchLetters({
  source,
  search,
}: {
  source: Letter[]
  search: Letter[]
}): SuggestionMatch | undefined {
  if (search.length > source.length) {
    return undefined
  }

  const prefix = search.every((
    letter,
    index,
  ) => letter.value === source[index]?.value)

  if (prefix) {
    const matched = source.slice(
      0,
      search.length,
    )

    return {
      ranges: matched.map(({
        from,
        to,
      }) => ({
        from,
        to,
      })),
      prefix: true,
      gaps: 0,
      wordStarts: matched.filter(letter => letter.wordStart).length,
    }
  }

  const partial: (MatchStep | undefined)[] = Array.from({ length: search.length })
  let best: MatchStep | undefined
  let fewestGaps = Infinity

  for (const [
    index,
    letter,
  ] of source.entries()) {
    for (let matched = search.length - 1; matched >= 0; matched--) {
      if (letter.value !== search[matched]?.value) {
        continue
      }

      const previous = partial[matched - 1]

      if (matched > 0 && !previous) {
        continue
      }

      const step: MatchStep = {
        letter,
        start: previous?.start ?? index,
        wordStarts: (previous?.wordStarts ?? 0) + Number(letter.wordStart),
        previous,
      }
      const current = partial[matched]

      if (!current || step.start > current.start
        || step.start === current.start && step.wordStarts > current.wordStarts) {
        partial[matched] = step
      }

      if (matched === search.length - 1) {
        const gaps = index - step.start + 1 - search.length

        if (gaps < fewestGaps || gaps === fewestGaps && step.wordStarts > (best?.wordStarts ?? 0)) {
          best = step
          fewestGaps = gaps
        }
      }
    }
  }

  if (!best) {
    return undefined
  }

  const ranges: SuggestionMatch['ranges'] = []
  let step: MatchStep | undefined = best

  while (step) {
    ranges.push({
      from: step.letter.from,
      to: step.letter.to,
    })
    step = step.previous
  }

  return {
    ranges: ranges.reverse(),
    prefix: false,
    gaps: fewestGaps,
    wordStarts: best.wordStarts,
  }
}

export function suggestionMatch({
  name,
  query,
}: {
  name: string
  query: string
}): SuggestionMatch | undefined {
  const words = query.split(/\s+/u).map(text => letters({ text }))
    .filter(word => word.length)

  if (!words.length) {
    return {
      ranges: [],
      prefix: true,
      gaps: 0,
      wordStarts: 0,
    }
  }

  const source = letters({ text: name })
  const search = words.flat()
  const prefix = search.every((
    letter,
    index,
  ) => letter.value === source[index]?.value)

  if (prefix) {
    return matchLetters({
      source,
      search,
    })
  }

  const matches: SuggestionMatch[] = []

  for (const word of words) {
    const match = matchLetters({
      source,
      search: word,
    })

    if (!match) {
      return undefined
    }

    matches.push(match)
  }

  const distinct = new Map(matches.flatMap(match => match.ranges).map(range => [
    range.from,
    range,
  ]))
  const ranges = [...distinct.values()].sort((
    a,
    b,
  ) => a.from - b.from)

  return {
    ranges,
    prefix: false,
    gaps: matches.reduce(
      (
        total,
        match,
      ) => total + match.gaps,
      0,
    ),
    wordStarts: matches.reduce(
      (
        total,
        match,
      ) => total + match.wordStarts,
      0,
    ),
  }
}

export function matchingSuggestions<T>({
  items,
  query,
  name,
  fallback,
}: {
  items: T[]
  query: string
  name: ({ item }: { item: T }) => string
  fallback?: ({ item }: { item: T }) => string
}): T[] {
  return items.flatMap(item => {
    const titleMatch = suggestionMatch({
      name: name({ item }),
      query,
    })
    let match = titleMatch

    if (!match && fallback) {
      match = suggestionMatch({
        name: fallback({ item }),
        query,
      })
    }

    return match ? [
      {
        item,
        match,
        context: !titleMatch,
      },
    ] : []
  }).sort((
    a,
    b,
  ) => Number(a.context) - Number(b.context)
    || Number(b.match.prefix) - Number(a.match.prefix)
    || a.match.gaps - b.match.gaps
    || b.match.wordStarts - a.match.wordStarts)
    .map(({ item }) => item)
}
