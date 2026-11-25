// One search rule for every list: no case or accents, each word anywhere in any order, "joaosilva" finds "João Silva".
interface Letter {
  value: string
  from: number
  to: number
  wordStart: boolean
}

interface Range {
  from: number
  to: number
}

// A row of a picker list, split into letters once when the list is built so typing only compares letters.
export interface PreparedRow<T> {
  key: string
  item: T
  title: Letter[]
  fallback?: Letter[]
  fallbackText?: string
}

export interface RowMatch<T> {
  row: PreparedRow<T>
  // Where the query matched: in the title, or in the fallback text when `context` is set.
  ranges: Range[]
  context: boolean
}

interface Match {
  ranges: Range[]
  prefix: boolean
  wordStarts: number
}

function letters({ text }: { text: string }): Letter[] {
  const result: Letter[] = []
  let offset = 0
  let wordStart = true

  for (const character of text) {
    const from = offset
    offset += character.length
    // NFD splits an accented letter into its base and a mark, and the filter drops the mark.
    const values = [
      ...character.toLowerCase().normalize('NFD')
        .replace(
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

function startsAt({
  source,
  word,
  start,
}: {
  source: Letter[]
  word: Letter[]
  start: number
}) {
  for (let index = 0; index < word.length; index++) {
    if (source[start + index]!.value !== word[index]!.value) {
      return false
    }
  }

  return true
}

// The word's first occurrence that starts a word in the text, else its first occurrence.
function findWord({
  source,
  word,
}: {
  source: Letter[]
  word: Letter[]
}): number | undefined {
  let first: number | undefined

  for (let start = 0; start + word.length <= source.length; start++) {
    if (!startsAt({
      source,
      word,
      start,
    })) {
      continue
    }

    if (source[start]!.wordStart) {
      return start
    }

    first ??= start
  }

  return first
}

function matchLetters({
  source,
  words,
}: {
  source: Letter[]
  words: Letter[][]
}): Match | undefined {
  const query = words.flat()

  if (query.length <= source.length && startsAt({
    source,
    word: query,
    start: 0,
  })) {
    return {
      ranges: source.slice(
        0,
        query.length,
      ).map(({
        from,
        to,
      }) => ({
        from,
        to,
      })),
      prefix: true,
      wordStarts: words.length,
    }
  }

  const matched = new Map<number, Range>()
  let wordStarts = 0

  for (const word of words) {
    const start = findWord({
      source,
      word,
    })

    if (start === undefined) {
      return undefined
    }

    wordStarts += Number(source[start]!.wordStart)

    for (const letter of source.slice(
      start,
      start + word.length,
    )) {
      matched.set(
        letter.from,
        {
          from: letter.from,
          to: letter.to,
        },
      )
    }
  }

  return {
    ranges: [...matched.values()].sort((
      a,
      b,
    ) => a.from - b.from),
    prefix: false,
    wordStarts,
  }
}

export function prepareRow<T>({
  key,
  item,
  title,
  fallback,
}: {
  key: string
  item: T
  title: string
  fallback?: string
}): PreparedRow<T> {
  return {
    key,
    item,
    title: letters({ text: title }),
    ...(fallback ? {
      fallback: letters({ text: fallback }),
      fallbackText: fallback,
    } : {}),
  }
}

// Title matches rank before fallback matches, then a match at the start, then more words matched where a word starts.
export function filterRows<T>({
  rows,
  query,
}: {
  rows: PreparedRow<T>[]
  query: string
}): RowMatch<T>[] {
  const words = query.split(/\s+/u).map(text => letters({ text }))
    .filter(word => word.length)

  if (!words.length) {
    return rows.map(row => ({
      row,
      ranges: [],
      context: false,
    }))
  }

  const found: (RowMatch<T> & { match: Match })[] = []

  for (const row of rows) {
    const title = matchLetters({
      source: row.title,
      words,
    })
    const match = title ?? (row.fallback && matchLetters({
      source: row.fallback,
      words,
    }))

    if (match) {
      found.push({
        row,
        ranges: match.ranges,
        context: !title,
        match,
      })
    }
  }

  return found.sort((
    a,
    b,
  ) => Number(a.context) - Number(b.context)
    || Number(b.match.prefix) - Number(a.match.prefix)
    || b.match.wordStarts - a.match.wordStarts)
    .map(({
      row,
      ranges,
      context,
    }) => ({
      row,
      ranges,
      context,
    }))
}
