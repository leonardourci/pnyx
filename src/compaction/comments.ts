import { sessionId } from '../core/tasks.ts'
import type { Card } from '../tasks/model.ts'

export const COMMENT_NOTE = '> Internal note: no reply needed: numbered comments refer to passages in your earlier reply. Short quotes include their paragraph for context. Address the comments together with the message below.'

export const hasComments = ({ text }: { text: string }) => /^## Comments on your reply from /m.test(text)

export const commentEpoch = ({ card }: { card: Card }) => {
  const session = card.agent ? sessionId({ agent: card.agent }) : 'unassigned'
  const matches = card.compaction?.commentSession === session
  const epoch = matches ? card.compaction?.commentEpoch : undefined

  return `${session}:${epoch ?? 'initial'}`
}

export const needsCommentNote = ({
  card,
  text,
}: {
  card: Card
  text: string
}) => hasComments({ text }) && card.compaction?.taughtEpoch !== commentEpoch({ card })

export function commentInput({
  card,
  id,
  text,
}: {
  card: Card
  id: string
  text: string
}) {
  return card.compaction?.commentMessage === id && hasComments({ text }) && !text.includes(COMMENT_NOTE) ? `${COMMENT_NOTE}\n\n${text}` : text
}
