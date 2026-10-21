import { enterNote } from './caret.ts'
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
  const note = host.querySelector<HTMLTextAreaElement>(
    `[data-comment-id="${CSS.escape(comment.id)}"] textarea`,
  )
  const range = commentRange({
    host,
    comment,
  })

  if (note) {
    enterNote({
      note,
      direction: 'backward',
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
  }
}
