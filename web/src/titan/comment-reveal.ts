import { focusAtEnd } from './composer-editable.ts'
import { commentRange } from './comment-highlight.ts'
import type { ChatComment } from './chat.ts'
import { COMMENT_REVEAL, scrollMessage } from './comment-motion.ts'

export function revealComment({
  host,
  comment,
}: {
  host: HTMLElement
  comment: ChatComment
}) {
  const note = host.querySelector<HTMLElement>(
    `[data-comment-id="${CSS.escape(comment.id)}"] .composer-text`,
  )
  const range = commentRange({
    host,
    comment,
  })

  if (note) {
    focusAtEnd({
      field: note,
      preventScroll: true,
    })
    scrollMessage({
      host,
      bounds: range?.getClientRects()[0] ?? note.getBoundingClientRect(),
      center: true,
      finished: () => host.dispatchEvent(new CustomEvent(
        COMMENT_REVEAL,
        { detail: comment.id },
      )),
    })

    return true
  }

  return false
}
