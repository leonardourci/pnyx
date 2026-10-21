import { MESSAGE_DECORATIONS, messageBlockKey } from './message-selection.ts'
import type { ChatComment } from './chat.ts'

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
  let found = wanted ? text.indexOf(wanted) : -1

  if (found >= 0 && comment.start !== undefined) {
    for (let next = text.indexOf(
      wanted,
      found + 1,
    ); next >= 0; next = text.indexOf(
        wanted,
        next + 1,
      )) {
      if (Math.abs(points[next]!.position - comment.start)
        < Math.abs(points[found]!.position - comment.start)) {
        found = next
      }
    }
  }

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

export function commentRange({
  host,
  comment,
}: {
  host: HTMLElement
  comment: ChatComment
}) {
  const block = host.querySelector(`[data-message-block="${CSS.escape(messageBlockKey(comment))}"]`)

  return block ? quoteRange({
    block,
    comment,
  }) : null
}

const FADE_DURATION = 160
let fades = 0
const fading = new Map<string, () => void>()

export function fadeHighlight({
  name,
  strength,
  underline = false,
}: {
  name: string
  strength: number
  underline?: boolean
}) {
  const before = CSS.highlights.get(name)
  CSS.highlights.delete(name)

  if (!before || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }

  const copy = new Highlight(...before)
  copy.priority = before.priority
  const fade = `${name}-fade-${++fades}`
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
      (performance.now() - started) / FADE_DURATION,
    )

    if (progress === 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clear()

      return
    }

    const opacity = (1 - progress) ** 2
    style.textContent = `::highlight(${fade}) { background-color: color-mix(in srgb, var(--color-gold) ${strength * opacity}%, transparent); ${underline ? `text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-gold) ${100 * opacity}%, transparent);` : ''} }`
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

  for (const [
    index,
    comment,
  ] of previous.entries()) {
    if (!present.has(comment.id)) {
      fadeHighlight({
        name: `${name}-${index}`,
        strength: 24,
      })
    }
  }

  const ranges = comments.flatMap((
    comment,
    index,
  ) => {
    const range = commentRange({
      host,
      comment,
    })
    const quote = `${name}-${index}`

    if (!range) {
      CSS.highlights.delete(quote)

      return []
    }

    CSS.highlights.set(
      quote,
      new Highlight(range),
    )

    return [range]
  })

  for (let index = comments.length; index < previous.length; index++) {
    CSS.highlights.delete(`${name}-${index}`)
  }

  CSS.highlights.set(
    name,
    new Highlight(...ranges),
  )
}
