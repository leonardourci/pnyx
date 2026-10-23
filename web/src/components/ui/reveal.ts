// Plain TypeScript, so node --test can import the reveal rules directly.
import type { Token, Tokens } from 'marked'

// Letters typed in the last EDGE ms are still fading in.
export const EDGE = 60
// How long a backlog takes to play out while the reply streams, and after it ends.
export const CATCHUP = 400
export const FINISH = 300
export const WINDOW = 1000
// Chars per ms.
export const MIN_SPEED = 120 / 1000
// How far the tail check looks back for an opener and ahead for its closer.
const REACH = 200
const FROM_START = 400
const LONG_WORD = 24

const MARKER_LINE = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]?|>|[-=_*]+)?[ \t]*$/
const MARKER = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)[ \t]+/
const FENCE = /^ {0,3}(```|~~~)/
// A table delimiter row, possibly still arriving.
const DELIMITER_SO_FAR = /^\|?[ :|-]*$/

export type Arrival = {
  t: number
  len: number
}

export function revealSpeed({
  rate,
  backlog,
  ended,
}: {
  rate: number
  backlog: number
  ended: boolean
}) {
  return Math.max(
    rate,
    backlog / (ended ? FINISH : CATCHUP),
    MIN_SPEED,
  )
}

// Records a push and returns the chars per ms that arrived over the last WINDOW.
export function arrivalRate({
  arrivals,
  now,
  length,
}: {
  arrivals: Arrival[]
  now: number
  length: number
}) {
  if (length !== arrivals.at(-1)?.len) {
    arrivals.push({
      t: now,
      len: length,
    })
  }

  const old = arrivals.findLastIndex(arrival => arrival.t <= now - WINDOW)
  arrivals.splice(
    0,
    Math.max(
      0,
      old,
    ),
  )

  return (length - arrivals[0]!.len) / WINDOW
}

// The whole word under the cursor goes in at once so it never jumps lines mid-word.
function typingEnd({
  text,
  cursor,
  final,
}: {
  text: string
  cursor: number
  final: boolean
}) {
  const i = Math.min(
    Math.floor(cursor),
    text.length,
  )

  if (i < text.length && /\s/.test(text[i]!)) {
    return i
  }

  let start = i, end = i

  while (start > 0 && !/\s/.test(text[start - 1]!)) {
    start--
  }

  while (end < text.length && !/\s/.test(text[end]!)) {
    end++
  }

  if (end - start > LONG_WORD) {
    return /[\uD800-\uDBFF]/.test(text[i - 1] ?? '') ? i + 1 : i
  }

  // A word still touching the end of the received text may grow.
  return end >= text.length && !final ? start : end
}

// `fenced` describes the text on screen, so a step stops where that fence closes.
function fenceStop({
  text,
  from,
  end,
}: {
  text: string
  from: number
  end: number
}) {
  let at = text[from - 1] === '\n' ? from : text.indexOf(
    '\n',
    from,
  ) + 1

  while (at > 0 && at < end) {
    if (FENCE.test(text.slice(
      at,
      at + 8,
    ))) {
      const newline = text.indexOf(
        '\n',
        at,
      )

      return newline < 0 ? text.length : newline
    }

    at = text.indexOf(
      '\n',
      at,
    ) + 1
  }

  return end
}

type Open = {
  run: string
  at: number
}

const lineStartBefore = ({
  text,
  at,
}: {
  text: string
  at: number
}) => text.lastIndexOf(
  '\n',
  at - 2,
) + 1

// Where the cursor may stop so half-written Markdown never shows.
export function safeEnd({
  text,
  end,
  final,
  fenced,
}: {
  text: string
  end: number
  final: boolean
  fenced: boolean
}): number {
  if (end >= text.length && final) {
    return end
  }

  const lineStart = text.lastIndexOf(
    '\n',
    end - 1,
  ) + 1
  const newline = text.indexOf(
    '\n',
    lineStart,
  )
  const lineEnd = newline < 0 ? text.length : newline
  const line = text.slice(
    lineStart,
    lineEnd,
  )
  const complete = newline >= 0 || final

  if (FENCE.test(line)) {
    return complete ? Math.max(
      end,
      lineEnd,
    ) : lineStart
  }

  if (fenced) {
    return end
  }

  const priorStart = lineStartBefore({
    text,
    at: lineStart,
  })
  const priorIsRow = text.slice(
    priorStart,
    lineStart,
  ).startsWith('|')
  const underHeader = priorIsRow && !text.slice(
    lineStartBefore({
      text,
      at: priorStart,
    }),
    priorStart,
  ).startsWith('|')

  // A table's header waits for its delimiter row.
  if (underHeader && !complete && DELIMITER_SO_FAR.test(line)) {
    return priorStart
  }

  if (MARKER_LINE.test(line)) {
    return complete ? end : lineStart
  }

  const marker = MARKER.exec(line)?.[0].length ?? 0

  if (end < lineStart + marker) {
    return lineStart + marker
  }

  if (line.startsWith('|')) {
    if (priorIsRow) {
      return complete ? Math.max(
        end,
        lineEnd,
      ) : lineStart
    }

    const second = newline < 0 ? -1 : text.indexOf(
      '\n',
      newline + 1,
    )
    const delimiter = newline < 0 ? '' : text.slice(
      newline + 1,
      second < 0 ? text.length : second,
    )

    if (!/^\|?[ :|-]+$/.test(delimiter)) {
      return DELIMITER_SO_FAR.test(delimiter) && !final ? lineStart : end
    }

    if (second < 0 && !final) {
      return lineStart
    }

    return Math.max(
      end,
      second < 0 ? text.length : second,
    )
  }

  // Emphasis never spans blocks, so the scan starts at the list item, heading or paragraph.
  let paraStart = lineStart

  while (paraStart > 0 && end - paraStart < REACH && !MARKER.test(text.slice(
    paraStart,
    paraStart + 12,
  ))) {
    const prior = lineStartBefore({
      text,
      at: paraStart,
    })

    if (text.slice(
      prior,
      paraStart - 1,
    ).trim() === '') {
      break
    }

    paraStart = prior
  }

  const open: Open[] = []

  for (let i = paraStart; i < end; i++) {
    const c = text[i]!

    // Nothing inside a code span counts.
    if (open.at(-1)?.run[0] === '`') {
      if (c !== '`') {
        continue
      }

      let j = i

      while (text[j] === '`') {
        j++
      }

      if (text.slice(
        i,
        j,
      ) === open.at(-1)!.run) {
        open.pop()
      }

      i = j - 1
      continue
    }

    if (c === '\\') {
      i++
      continue
    }

    if (c === '`' || c === '*' || c === '_' || c === '~') {
      let j = i

      while (text[j] === c) {
        j++
      }

      const run = text.slice(
        i,
        j,
      )
      const before = text[i - 1] ?? ' '
      const after = text[j] ?? ' '

      // A run touching the end of what has arrived cannot be judged yet.
      if (j >= text.length && !final) {
        return open.find(o => end - o.at < REACH)?.at ?? i
      }

      const top = open.at(-1)
      const opens = c === '`' || (!/\s/.test(after) && !(c === '_' && /\w/.test(before))
        && (c !== '~' || run.length === 2))

      if (top && top.run === run && !/\s/.test(before)) {
        open.pop()

        // Never stop inside a closing run.
        if (j > end && !open.length) {
          return j
        }
      } else if (opens) {
        open.push({
          run,
          at: i,
        })
      }

      i = j - 1
    } else if (c === '[') {
      open.push({
        run: ']',
        at: i,
      })
    } else if (c === ']' && open.at(-1)?.run === ']') {
      if (i + 1 >= text.length && !final) {
        return open.at(-1)!.at
      }

      const bracket = open.pop()!.at

      if (text[i + 1] === '(') {
        open.push({
          run: ')',
          at: bracket,
        })
      }
    } else if (c === ')' && open.at(-1)?.run === ')') {
      open.pop()
    }
  }

  const first = open.find(o => end - o.at < REACH)

  if (!first) {
    return end
  }

  const closer = first.run === ']' || first.run === ')' ? ')' : first.run
  const from = Math.max(
    end,
    first.at + first.run.length,
  )
  const ahead = text.slice(
    from,
    first.at + REACH,
  )
  const blank = ahead.indexOf('\n\n')
  const found = ahead.slice(
    0,
    blank < 0 ? undefined : blank,
  ).indexOf(closer)

  if (found >= 0) {
    return from + found + closer.length
  }

  const closable = !final && blank < 0 && end - first.at < REACH

  return closable ? first.at : end
}

// One frame: `cursor` is the typed position (fractional), `shown` how much text the DOM holds.
export function revealStep({
  text,
  cursor,
  shown,
  speed,
  elapsed,
  final,
  fenced,
}: {
  text: string
  cursor: number
  shown: number
  speed: number
  elapsed: number
  final: boolean
  fenced: boolean
}) {
  const target = Math.min(
    text.length,
    cursor + speed * elapsed,
  )
  const word = typingEnd({
    text,
    cursor: target,
    final,
  })
  const end = fenced ? Math.min(
    word,
    fenceStop({
      text,
      from: shown,
      end: word,
    }),
  ) : word
  const held = safeEnd({
    text,
    end,
    final,
    fenced,
  })
  const next = Math.max(
    shown,
    Math.min(
      text.length,
      held,
    ),
  )

  return {
    cursor: Math.max(
      cursor,
      Math.min(
        target,
        next,
      ),
    ),
    shown: next,
  }
}

export type Block = {
  offset: number
  // Markdown's block index for the first token, which comments store.
  index: number
  raw: string
  tokens: Token[]
}

// Counts the `block` calls renderBlocks in markdown.tsx makes for these tokens.
function blockCount({
  tokens,
  inItem = false,
}: {
  tokens: Token[]
  inItem?: boolean
}): number {
  let count = 0

  for (const token of tokens) {
    if (token.type === 'blockquote') {
      count += blockCount({ tokens: token.tokens ?? [] })
    } else if (token.type === 'list') {
      for (const item of (token as Tokens.List).items) {
        count += 1 + blockCount({
          tokens: item.tokens,
          inItem: true,
        })
      }
    } else if (![
      'space',
      'checkbox',
      'hr',
    ].includes(token.type)
      && !(inItem && (token.type === 'paragraph' || token.type === 'text'))) {
      count++
    }
  }

  return count
}

const lastBlock = ({ tokens }: { tokens: Token[] }) => {
  let end = tokens.length - 1

  while (end > 0 && tokens[end]!.type === 'space') {
    end--
  }

  return Math.max(
    0,
    end,
  )
}

const openFence = ({ token }: { token?: Token }) => token?.type === 'code' && FENCE.test(token.raw)
  && token.raw.trimEnd().split('\n')
    .filter(line => FENCE.test(line)).length < 2

// Every top-level token before the last non-space one is complete and is never lexed again.
export function splitBlocks({
  text,
  boundary,
  done,
  lex,
}: {
  text: string
  boundary: number
  done: Block[]
  lex({ text }: { text: string }): Token[]
}) {
  const tokens = lex({ text: text.slice(boundary) })
  const previous = done.at(-1)
  const end = lastBlock({ tokens })
  let index = previous ? previous.index + blockCount({ tokens: previous.tokens }) : 0

  for (const token of tokens.slice(
    0,
    end,
  )) {
    done.push({
      offset: boundary,
      index,
      raw: token.raw,
      tokens: [token],
    })
    boundary += token.raw.length
    index += blockCount({ tokens: [token] })
  }

  const live = tokens.slice(end)

  return {
    boundary,
    live: {
      offset: boundary,
      index,
      raw: text.slice(boundary),
      tokens: live,
    },
    fenced: openFence({ token: live[0] }),
  }
}

export const fencedTail = ({
  text,
  boundary,
  lex,
}: {
  text: string
  boundary: number
  lex({ text }: { text: string }): Token[]
}) => {
  const tokens = lex({ text: text.slice(boundary) })

  return openFence({ token: tokens[lastBlock({ tokens })] })
}

// A short streaming reply types from the start; a longer one (a reload) shows what arrived.
export function mountShown({
  text,
  fromStart,
  lex,
}: {
  text: string
  fromStart: boolean
  lex({ text }: { text: string }): Token[]
}) {
  if (fromStart && text.length <= FROM_START) {
    return 0
  }

  return safeEnd({
    text,
    end: text.length,
    final: false,
    fenced: fencedTail({
      text,
      boundary: 0,
      lex,
    }),
  })
}
