import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { ownerQuestions } from '#tasks/questions.ts'
import { reviewRequests } from './review-requests.ts'

export function taskQuestions({
  state,
  card,
}: {
  state?: TitanState
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
