import { enterNote } from './caret.ts'
import { commentRange } from './comment-highlight.ts'
import type { ChatComment } from './chat.ts'

export const COMMENT_REVEAL = 'pnyx-comment-reveal'

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
    const passage = range?.startContainer.parentElement
    ;(passage ?? note).scrollIntoView({ block: 'center' })
    enterNote({
      note,
      direction: 'backward',
    })
    host.dispatchEvent(new CustomEvent(
      COMMENT_REVEAL,
      { detail: comment.id },
    ))
  }
}
