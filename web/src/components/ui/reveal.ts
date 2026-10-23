// The pure rules behind a streamed reply's reveal: how fast it types, where it may stop,
// and which blocks are complete. Plain TypeScript so node --test can import it.
import type { Token, Tokens } from 'marked'

// Letters typed in the last EDGE ms are still fading in.
export const EDGE = 60
// How long a backlog takes to play out while the reply streams, and after it ends.
export const CATCHUP = 400
export const FINISH = 300
// The arrival rate is measured over the last WINDOW ms of pushes.
export const WINDOW = 1000
// Chars per ms: the slowest the reveal ever types.
export const MIN = 120 / 1000
// How far the tail check looks back for an opener and ahead for its closer.
export const LIMIT = 200
// A streaming message mounted with at most this much text types from the start.
export const FROM_START = 400
const LONG_WORD = 24

const MARKER_LINE = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]?|>|[-=_*]+)?[ \t]*$/
const MARKER = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)[ \t]+/
const FENCE = /^ {0,3}(```|~~~)/

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
    MIN,
  )
}

// Typing lays out the whole word the cursor is in, so a word never jumps to the next
// line while it types. A word that still touches the end of the received text may
// grow, so typing waits before it; a word longer than LONG_WORD types as it comes.
export function typingEnd({
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

  let j = i, k = i

  while (j > 0 && !/\s/.test(text[j - 1]!)) {
    j--
  }

  while (k < text.length && !/\s/.test(text[k]!)) {
    k++
  }

  if (k - j > LONG_WORD) {
    return /[\uD800-\uDBFF]/.test(text[i - 1] ?? '') ? i + 1 : i
  }

  return k >= text.length && !final ? j : k
}

// safeEnd's `fenced` describes the text on screen. When a step would cross the line
// that closes that fence, it stops at the end of that line, so the next step judges
// what follows with the fence closed.
export function fenceStop({
  text,
  from,
  end,
}: {
  text: string
  from: number
  end: number
}) {
  for (let at = text[from - 1] === '\n' ? from : text.indexOf(
    '\n',
    from,
  ) + 1;
    at > 0 && at < end;
    at = text.indexOf(
      '\n',
      at,
    ) + 1) {
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
  }

  return end
}

type Open = {
  run: string
  at: number
}

// Where the cursor may stop so half-written Markdown never shows: a marker waits for
// its closer, or the span shows whole once the closer has arrived.
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

  const priorStart = text.lastIndexOf(
    '\n',
    lineStart - 2,
  ) + 1
  const underHeader = text.slice(
    priorStart,
    lineStart,
  ).startsWith('|')
    && !text.slice(
      text.lastIndexOf(
        '\n',
        priorStart - 2,
      ) + 1,
      priorStart,
    ).startsWith('|')

  // While its delimiter row is still arriving, a table's header waits with it.
  if (underHeader && !complete && /^\|?[ :|-]*$/.test(line)) {
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
    const header = !text.slice(
      priorStart,
      lineStart,
    ).startsWith('|')

    if (!header) {
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
      return /^\|?[ :|-]*$/.test(delimiter) && !final ? lineStart : end
    }

    return second >= 0 || final ? Math.max(
      end,
      second < 0 ? text.length : second,
    ) : lineStart
  }

  // Emphasis never spans blocks: scan from the start of the list item, heading or paragraph.
  let paraStart = lineStart

  while (paraStart > 0 && end - paraStart < LIMIT
    && !/^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]|>)[ \t]/.test(text.slice(
      paraStart,
      paraStart + 12,
    ))) {
    const prior = text.lastIndexOf(
      '\n',
      paraStart - 2,
    ) + 1

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
        ), before = text[i - 1] ?? ' ', after = text[j] ?? ' '

      // A run that touches the end of what has arrived cannot be judged yet.
      if (j >= text.length && !final) {
        return open.find(o => end - o.at < LIMIT)?.at ?? i
      }

      const top = open.at(-1)

      if (top && top.run === run && !/\s/.test(before)) {
        open.pop()

        // Never stop inside a closing run.
        if (j > end && !open.length) {
          return j
        }
      } else if (c === '`' || (!/\s/.test(after) && !(c === '_' && /\w/.test(before))
        && (c !== '~' || run.length === 2))) {
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

  const first = open.find(o => end - o.at < LIMIT)

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
    first.at + LIMIT,
  )
  const blank = ahead.indexOf('\n\n')
  const found = ahead.slice(
    0,
    blank < 0 ? undefined : blank,
  ).indexOf(closer)

  // The closer is here: show the span whole.
  if (found >= 0) {
    return from + found + closer.length
  }

  // It can no longer close: show it as it is.
  if (final || blank >= 0 || end - first.at >= LIMIT) {
    return end
  }

  return first.at
}

// One frame of typing: `cursor` is the typed position (fractional), `shown` how much
// text the DOM holds. The DOM gets the whole word the cursor is in, held back by the
// tail check; the cursor never passes it.
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
  const next = Math.max(
    shown,
    Math.min(
      text.length,
      safeEnd({
        text,
        end,
        final,
        fenced,
      }),
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
  // The message block index its first token starts at, as Markdown counts them.
  index: number
  raw: string
  tokens: Token[]
}

// How many times Markdown's renderer calls `block` for these tokens. Keep in step with
// `renderBlocks` in markdown.tsx.
export const blockCount = ({
  tokens,
  inItem = false,
}: {
  tokens: Token[]
  inItem?: boolean
}): number => tokens.reduce(
  (
    sum,
    token,
  ) => sum + (token.type === 'space' || token.type === 'checkbox' || token.type === 'hr' ? 0
    : token.type === 'blockquote' ? blockCount({ tokens: token.tokens ?? [] })
      : token.type === 'list' ? (token as Tokens.List).items.reduce(
        (
          n,
          item,
        ) => n + 1 + blockCount({
          tokens: item.tokens,
          inItem: true,
        }),
        0,
      )
        : inItem && (token.type === 'paragraph' || token.type === 'text') ? 0 : 1),
  0,
)

const openFence = ({ token }: { token?: Token }) => token?.type === 'code' && FENCE.test(token.raw)
  && token.raw.trimEnd().split('\n')
    .filter(line => FENCE.test(line)).length < 2

// Completed blocks are lexed once and kept in `done`; only the growing block is lexed
// again. Every top-level token before the last non-space one is complete.
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
  const last = done.at(-1)
  let index = last ? last.index + blockCount({ tokens: last.tokens }) : 0
  let end = tokens.length - 1

  while (end > 0 && tokens[end]!.type === 'space') {
    end--
  }

  for (const token of tokens.slice(
    0,
    Math.max(
      0,
      end,
    ),
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

  const live = tokens.slice(Math.max(
    0,
    end,
  ))

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

// Whether the growing block of `text` past `boundary` is an open code fence.
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
  let end = tokens.length - 1

  while (end > 0 && tokens[end]!.type === 'space') {
    end--
  }

  return openFence({ token: tokens[end] })
}

// What a message shows when it mounts: a short streaming reply types from the start,
// a longer one (a reload mid-reply) shows what has arrived, minus half-written Markdown.
export function mountShown({
  text,
  streaming,
  lex,
}: {
  text: string
  streaming: boolean
  lex({ text }: { text: string }): Token[]
}) {
  if (!streaming) {
    return text.length
  }

  if (text.length <= FROM_START) {
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
