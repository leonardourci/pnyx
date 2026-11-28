import type { TitanState } from '#app/model.ts'
import type { Ask, Card } from '#tasks/model.ts'
import { activeAsks, openAsks } from '#tasks/ask-state.ts'
import { isCanonicalQuestion } from '#tasks/delivery/merge-questions.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { taskMentions } from '#titan/mentions.ts'
import { reviewRequests, type ReviewRequest } from '#web-tasks/review-requests.ts'

export interface ChatDecision {
  id: string
  at: string
  card: Card
  ask: Ask
  relatedTask?: Card
  review?: ReviewRequest
}

export function chatDecisions({
  state,
  selectedTask,
  draft = '',
}: {
  state: TitanState
  selectedTask?: string | null
  draft?: string
}): ChatDecision[] {
  const latest = state.titanOwnerMessage
  const context = new Set([
    selectedTask,
    latest?.task,
    ...taskMentions({ text: latest?.text ?? '' }).map(mention => mention.id),
    ...taskMentions({ text: draft }).map(mention => mention.id),
  ].map(ref => ref ? state.keys[ref] ?? ref : undefined))

  const cards = Object.values(state.cards)

  return cards.flatMap(card => {
    const asks = card.id === TITAN_CARD ? openAsks : activeAsks

    return asks({
      card,
      audience: 'owner',
    }).flatMap(ask => {
      if (!isCanonicalQuestion({
        state,
        card,
        ask,
      })) {
        return []
      }

      const relatedTask = ask.kind === 'merge' && ask.url
        ? cards.find(task => context.has(task.id) && task.links.some(link => link.url === ask.url))
        : undefined
      const visible = card.id === TITAN_CARD || context.has(card.id) || !!relatedTask

      if (!visible) {
        return []
      }

      const review = reviewRequests({
        state,
        card,
      }).find(request => request.card.id === card.id && request.ask.id === ask.id)

      return [
        {
          id: `ask:${card.id}:${ask.id}`,
          at: ask.reaskedAt ?? ask.escalated?.at ?? ask.at,
          card,
          ask,
          relatedTask,
          review,
        },
      ]
    })
  })
}
