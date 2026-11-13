import type { Ask, AskAudience, Card } from './model.ts'
import type { HydraState } from '#app/model.ts'

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

// Answers recorded from the owner's messages, which the owner can still undo.
export const recordedAnswers = ({ card }: { card: Card }) =>
  (card.asks ?? []).filter(ask => ask.answered && ask.fromMessage && !ask.closed)

export const activeAsks = ({
  card,
  audience,
}: {
  card: Card
  audience?: AskAudience
}) =>
  openAsks({
    card,
    audience,
  }).filter(ask => !ask.deferredUntil)

export const deferredQuestions = ({ state }: { state: HydraState }) =>
  Object.values(state.cards).flatMap(card => openAsks({
    card,
    audience: 'owner',
  })
    .filter((ask): ask is Ask & { deferredUntil: string } => ask.deferredUntil !== undefined)
    .map(ask => ({
      card,
      ask,
      at: Date.parse(ask.deferredUntil),
    })))

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
