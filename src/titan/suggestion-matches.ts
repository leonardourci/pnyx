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

export interface PreparedRow<T> {
  item: T
  title: Letter[]
  fallback?: {
    text: string
    letters: Letter[]
  }
}

export interface RowMatch<T> {
  row: PreparedRow<T>
  ranges: Range[]
  inFallback: boolean
}

interface Match {
  ranges: Range[]
  prefix: boolean
  wordStarts: number
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

function letters({ text }: { text: string }): Letter[] {
  const result: Letter[] = []
  let offset = 0
  let wordStart = true

  for (const character of text) {
    const from = offset
    offset += character.length
    const accentsSplitOff = character.toLowerCase().normalize('NFD')
      .replace(
        /ς/gu,
        'σ',
      )
    const values = [...accentsSplitOff].filter(value => LETTER_OR_DIGIT.test(value))

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
    if (source[start + index].value !== word[index].value) {
      return false
    }
  }

  return true
}

function findPreferringWordStart({
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

    if (source[start].wordStart) {
      return start
    }

    first ??= start
  }

  return first
}

function characterRanges({ matched }: { matched: Letter[] }): Range[] {
  const ranges = new Map<number, Range>()

  for (const letter of matched) {
    ranges.set(
      letter.from,
      {
        from: letter.from,
        to: letter.to,
      },
    )
  }

  return [...ranges.values()].sort((
    a,
    b,
  ) => a.from - b.from)
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
      ranges: characterRanges({
        matched: source.slice(
          0,
          query.length,
        ),
      }),
      prefix: true,
      wordStarts: words.length,
    }
  }

  const matched: Letter[] = []
  let wordStarts = 0

  for (const word of words) {
    const start = findPreferringWordStart({
      source,
      word,
    })

    if (start === undefined) {
      return undefined
    }

    wordStarts += Number(source[start].wordStart)
    matched.push(...source.slice(
      start,
      start + word.length,
    ))
  }

  return {
    ranges: characterRanges({ matched }),
    prefix: false,
    wordStarts,
  }
}

export function prepareRow<T extends { title: string }>({
  item,
  fallback,
}: {
  item: T
  fallback?: string
}): PreparedRow<T> {
  const row: PreparedRow<T> = {
    item,
    title: letters({ text: item.title }),
  }

  if (fallback) {
    row.fallback = {
      text: fallback,
      letters: letters({ text: fallback }),
    }
  }

  return row
}

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
      inFallback: false,
    }))
  }

  const found: {
    result: RowMatch<T>
    match: Match
  }[] = []

  for (const row of rows) {
    const title = matchLetters({
      source: row.title,
      words,
    })
    const match = title ?? (row.fallback && matchLetters({
      source: row.fallback.letters,
      words,
    }))

    if (match) {
      found.push({
        result: {
          row,
          ranges: match.ranges,
          inFallback: !title,
        },
        match,
      })
    }
  }

  return found.sort((
    a,
    b,
  ) => Number(a.result.inFallback) - Number(b.result.inFallback)
    || Number(b.match.prefix) - Number(a.match.prefix)
    || b.match.wordStarts - a.match.wordStarts)
    .map(({ result }) => result)
}
