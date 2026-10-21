import { MESSAGE_DECORATIONS, messageBlockKey } from './message-selection.ts'
import { quoteStart, type ChatComment } from './chat.ts'

// The block's own text: links included, its comment cards and the pill left out.
function* blockText({ block }: { block: Element }) {
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  )

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest(MESSAGE_DECORATIONS)) {
      yield node
    }
  }
}

type Point = {
  node: Text
  offset: number
  position: number
}

function quoteRange({
  block,
  comment,
}: {
  block: Element
  comment: ChatComment
}) {
  let text = ''
  const points: Point[] = []
  let position = 0

  for (const node of blockText({ block })) {
    for (let offset = 0; offset < node.length; offset++, position++) {
      const space = /\s/.test(node.data[offset]!)

      if (!space || text && !text.endsWith(' ')) {
        text += space ? ' ' : node.data[offset]
        points.push({
          node,
          offset,
          position,
        })
      }
    }
  }

  const wanted = comment.quote.replace(
    /\s+/g,
    ' ',
  ).trim()
  const found = quoteStart({
    text,
    quote: wanted,
    start: comment.start,
    positions: points.map(point => point.position),
  })

  // A whole-block comment quotes the block's Markdown source, so it marks all of the block.
  const whole = found < 0 && comment.quote === comment.paragraph && points.length > 0
  const at = whole ? 0 : found
  const length = whole ? points.length : wanted.length

  if (at < 0) {
    return null
  }

  const start = points[at]!, end = points[at + length - 1]!
  const range = document.createRange()
  range.setStart(
    start.node,
    start.offset,
  )
  range.setEnd(
    end.node,
    end.offset + 1,
  )

  return range
}

export const HIGHLIGHT_SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in CSS

const pointAt = ({
  block,
  position,
}: {
  block: Element
  position: number
}) => {
  let remaining = position
  const texts = [...blockText({ block })]

  for (const node of texts) {
    if (remaining <= node.length) {
      return {
        node,
        offset: remaining,
      }
    }

    remaining -= node.length
  }

  const node = texts.at(-1)

  return node ? {
    node,
    offset: node.length,
  } : null
}

export function commentRange({
  host,
  comment,
}: {
  host: HTMLElement
  comment: ChatComment
}) {
  const block = host.querySelector(`[data-message-block="${CSS.escape(messageBlockKey(comment))}"]`)

  if (!block) {
    return null
  }

  if (!comment.end) {
    return quoteRange({
      block,
      comment,
    })
  }

  const endBlock = host.querySelector(`[data-message-block="${CSS.escape(messageBlockKey({
    messageId: comment.messageId,
    offset: comment.end.offset,
  }))}"]`)

  if (!endBlock) {
    return null
  }

  const start = pointAt({
    block,
    position: comment.start ?? 0,
  })
  const end = pointAt({
    block: endBlock,
    position: comment.end.position,
  })

  if (!start || !end) {
    return null
  }

  const range = document.createRange()
  range.setStart(
    start.node,
    start.offset,
  )
  range.setEnd(
    end.node,
    end.offset,
  )

  return range
}

export function commentRanges({
  host,
  comment,
}: {
  host: HTMLElement
  comment: ChatComment
}) {
  const selection = commentRange({
    host,
    comment,
  })
  const message = selection?.startContainer.parentElement?.closest('.message')

  if (!selection || !message) {
    return []
  }

  return [...blockText({ block: message })].flatMap(node => {
    if (!selection.intersectsNode(node)) {
      return []
    }

    const start = selection.startContainer === node ? selection.startOffset : 0
    const end = selection.endContainer === node ? selection.endOffset : node.length

    if (start >= end) {
      return []
    }

    const range = document.createRange()
    range.setStart(
      node,
      start,
    )
    range.setEnd(
      node,
      end,
    )

    return [range]
  })
}

let fades = 0
const fading = new Map<string, () => void>()

export const commentHighlightName = ({
  name,
  id,
}: {
  name: string
  id: string
}) => `${name}-quote-${id}`

export function fadeHighlight({
  name,
  scope,
  emphasis = false,
}: {
  name: string
  scope: string
  emphasis?: boolean
}) {
  const before = CSS.highlights.get(name)
  CSS.highlights.delete(name)

  if (!before || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }

  const first = [...before][0]

  if (!first) {
    return
  }

  const theme = getComputedStyle(first.startContainer.parentElement ?? document.documentElement)
  const duration = parseFloat(theme.getPropertyValue('--comment-fade-duration'))
  const strength = parseFloat(theme.getPropertyValue(emphasis ? '--comment-emphasis-strength' : '--comment-highlight-strength'))
  const copy = new Highlight(...before)
  copy.priority = before.priority
  const fade = `${scope}-fade-${emphasis ? 'emphasis' : 'quote'}-${++fades}`
  const style = document.createElement('style')
  style.id = fade
  CSS.highlights.set(
    fade,
    copy,
  )
  document.head.append(style)
  let frame = 0
  const started = performance.now()

  const clear = () => {
    cancelAnimationFrame(frame)
    CSS.highlights.delete(fade)
    style.remove()
    fading.delete(fade)
  }

  const paint = () => {
    const progress = Math.min(
      1,
      (performance.now() - started) / duration,
    )

    if (progress === 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clear()

      return
    }

    const opacity = (1 - progress) ** 2
    style.textContent = `::highlight(${fade}) { background-color: color-mix(in srgb, var(--color-gold) ${strength * opacity}%, transparent); ${emphasis ? `text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-gold) ${100 * opacity}%, transparent);` : ''} }`
    frame = requestAnimationFrame(paint)
  }

  fading.set(
    fade,
    clear,
  )
  paint()
}

export function clearHighlights({ name }: { name: string }) {
  if (!HIGHLIGHT_SUPPORTED) {
    return
  }

  for (const [
    key,
    clear,
  ] of fading) {
    if (key.startsWith(`${name}-`)) {
      clear()
    }
  }

  for (const key of CSS.highlights.keys()) {
    if (key === name || key.startsWith(`${name}-`)) {
      CSS.highlights.delete(key)
    }
  }
}

export function paintComments({
  host,
  name,
  comments,
  previous,
}: {
  host: HTMLElement
  name: string
  comments: ChatComment[]
  previous: ChatComment[]
}) {
  const present = new Set(comments.map(comment => comment.id))

  for (const comment of previous) {
    if (!present.has(comment.id)) {
      fadeHighlight({
        name: commentHighlightName({
          name,
          id: comment.id,
        }),
        scope: name,
      })
    }
  }

  comments.forEach(comment => {
    const ranges = commentRanges({
      host,
      comment,
    })
    const quote = commentHighlightName({
      name,
      id: comment.id,
    })

    if (!ranges.length) {
      CSS.highlights.delete(quote)

      return
    }

    CSS.highlights.set(
      quote,
      new Highlight(...ranges),
    )
  })
}
