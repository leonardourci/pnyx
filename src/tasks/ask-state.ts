import type { Ask, AskAudience, Card } from './model.ts'

const currentAnswerReplies = ({
  card,
  question,
}: {
  card: Card
  question: string
}) => {
  const round = card.asks?.find(ask => ask.id === question)?.answerRound

  return card.replies?.filter(reply =>
    reply.answers === question && reply.decision?.answerRound === round) ?? []
}

// An answer still being sent, or one that may have landed, holds the question until someone checks.
export const pendingAnswer = ({
  card,
  ask,
}: {
  card: Card
  ask: Ask
}) => currentAnswerReplies({
  card,
  question: ask.id,
})
  .find(reply => reply.state === 'queued' || reply.state === 'delivery_unknown')

export const openAsks = ({
  card,
  audience,
}: {
  card: Card
  audience?: AskAudience
}) => (card.asks ?? []).filter(a =>
  !a.answered && !a.closed && (!audience || a.audience === audience))

export const askWording = ({ ask }: { ask: Ask }) => ({
  question: ask.escalated?.question ?? ask.question,
  context: ask.escalated?.context ?? ask.context,
})

export function answerDelivery({
  card,
  question,
}: {
  card: Card
  question: string
}) {
  return currentAnswerReplies({
    card,
    question,
  }).at(-1)
}
