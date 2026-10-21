import { messageBlockKey } from './message-selection.ts'
import type { ChatComment } from './chat.ts'

// The block's own text: links included, its comment cards and the pill left out.
function* blockText({ block }: { block: Element }) {
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  )

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest('.comment-card, .comment-pill')) {
      yield node
    }
  }
}

type Point = {
  node: Text
  offset: number
}

// ponytail: matched with whitespace collapsed, first occurrence wins; store the offset if repeats matter.
function quoteRange({
  block,
  comment,
}: {
  block: Element
  comment: ChatComment
}) {
  let text = ''
  const points: Point[] = []

  for (const node of blockText({ block })) {
    for (let offset = 0; offset < node.length; offset++) {
      const space = /\s/.test(node.data[offset]!)

      if (!space || text && !text.endsWith(' ')) {
        text += space ? ' ' : node.data[offset]
        points.push({
          node,
          offset,
        })
      }
    }
  }

  const wanted = comment.quote.replace(
    /\s+/g,
    ' ',
  ).trim()
  const found = wanted ? text.indexOf(wanted) : -1
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

export function paintComments({
  host,
  name,
  comments,
}: {
  host: HTMLElement
  name: string
  comments: ChatComment[]
}) {
  const ranges = comments.flatMap(comment => {
    const block = host.querySelector(`[data-message-block="${CSS.escape(messageBlockKey(comment))}"]`)
    const range = block && quoteRange({
      block,
      comment,
    })

    return range ? [range] : []
  })

  CSS.highlights.set(
    name,
    new Highlight(...ranges),
  )
}
