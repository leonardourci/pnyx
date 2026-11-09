import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { ownerQuestions } from '#tasks/questions.ts'
import { reviewRequests } from './review-requests.ts'

export const hasTaskQuestion = ({ card }: { card: Card }) => ownerQuestions({ card }).length > 0

export function taskQuestions({
  state,
  card,
}: {
  state?: HydraState
  card: Card
}) {
  const questions = ownerQuestions({
    card,
    cards: state?.cards,
  })
  const reviews = reviewRequests({
    state,
    card,
  })
  const asks = questions.flatMap(({ ask }) => {
    if (!ask) {
      return []
    }

    const rendered = reviews.some(review => review.card.id === card.id && review.ask.id === ask.id)

    return rendered ? [] : [ask]
  })

  return {
    questions,
    reviews,
    asks,
  }
}
