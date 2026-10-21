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

export function paintComments({
  host,
  name,
  comments,
}: {
  host: HTMLElement
  name: string
  comments: ChatComment[]
}) {
  const names: string[] = []
  const ranges = comments.flatMap((
    comment,
    index,
  ) => {
    const range = commentRange({
      host,
      comment,
    })

    if (!range) {
      return []
    }

    const quote = `${name}-${index}`
    names.push(quote)
    CSS.highlights.set(
      quote,
      new Highlight(range),
    )

    return [range]
  })

  CSS.highlights.set(
    name,
    new Highlight(...ranges),
  )

  return () => {
    for (const quote of names) {
      CSS.highlights.delete(quote)
    }

    CSS.highlights.delete(name)
  }
}
