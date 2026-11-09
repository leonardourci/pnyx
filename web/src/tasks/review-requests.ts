import type { HydraState } from '#app/model.ts'
import type { Ask, Card } from '#tasks/model.ts'
import { readyForReview, type Link } from '#tasks/delivery/model.ts'
import { canonicalMergeQuestion } from '#tasks/delivery/merge-questions.ts'

export interface ReviewRequest {
  card: Card
  ask: Ask
  link: Link
}

export function reviewRequests({
  state,
  card,
}: {
  state?: HydraState
  card: Card
}): ReviewRequest[] {
  return card.links.flatMap(link => {
    if (!readyForReview({ link })) {
      return []
    }

    const canonical = canonicalMergeQuestion({
      state,
      card,
      url: link.url,
    })

    if (!canonical || canonical.ask.closed) {
      return []
    }

    return [
      {
        ...canonical,
        link,
      },
    ]
  })
}

export function reviewState({ request }: { request: ReviewRequest }): string {
  const {
    ask,
    link,
  } = request

  if (link.mergeAttempt) {
    return 'Merge awaiting confirmation'
  }

  if (ask.answered && ask.choice === 'Merge') {
    return 'Merge approved'
  }

  if (ask.answered && ask.choice === 'Hold') {
    return 'Review on hold'
  }

  return ask.deferredUntil ? 'Review later' : 'Ready for review'
}
