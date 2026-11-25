import { commentRange } from './comment-highlight.ts'
import type { ChatComment } from './chat.ts'
import { COMMENT_REVEAL, scrollMessage } from './comment-motion.ts'

export function focusNote({
  note,
  preventScroll = false,
}: {
  note: HTMLTextAreaElement
  preventScroll?: boolean
}) {
  note.focus({ preventScroll })
  note.setSelectionRange(
    note.value.length,
    note.value.length,
  )
}

export function revealComment({
  host,
  comment,
}: {
  host: HTMLElement
  comment: ChatComment
}) {
  const note = host.querySelector<HTMLTextAreaElement>(
    `[data-comment-id="${CSS.escape(comment.id)}"] textarea`,
  )
  const range = commentRange({
    host,
    comment,
  })

  if (note) {
    focusNote({
      note,
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
