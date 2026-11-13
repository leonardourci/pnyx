import type { HydraState } from '#app/model.ts'
import type { Ask, Card } from '#tasks/model.ts'
import { activeAsks, openAsks } from '#tasks/ask-state.ts'
import { isCanonicalQuestion } from '#tasks/delivery/merge-questions.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMentions } from '#hydra/mentions.ts'
import { reviewRequests, type ReviewRequest } from '#web-tasks/review-requests.ts'

export interface ChatDecision {
  id: string
  at: string
  card: Card
  ask: Ask
  blocker: boolean
  relatedTask?: Card
  review?: ReviewRequest
}

export function chatDecisions({
  state,
  selectedTask,
  draft = '',
}: {
  state: HydraState
  selectedTask?: string | null
  draft?: string
}): ChatDecision[] {
  const latest = state.hydraOwnerMessage
  const context = new Set([
    selectedTask,
    latest?.task,
    ...taskMentions({ text: latest?.text ?? '' }).map(mention => mention.id),
    ...taskMentions({ text: draft }).map(mention => mention.id),
  ].map(ref => ref ? state.keys[ref] ?? ref : undefined))

  const cards = Object.values(state.cards)

  return cards.flatMap(card => {
    const asks = card.id === HYDRA_CARD ? openAsks : activeAsks

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

      let relatedTask: Card | undefined

      if (ask.kind === 'merge' && ask.url) {
        const linked = cards.filter(task => task.links.some(link => link.url === ask.url))
        relatedTask = linked.find(task => task.status?.state === 'blocked')
          ?? linked.find(task => context.has(task.id))
      }

      const blocker = card.status?.state === 'blocked' || relatedTask?.status?.state === 'blocked'
      const visible = card.id === HYDRA_CARD || blocker || context.has(card.id) || !!relatedTask

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
          blocker,
          relatedTask,
          review,
        },
      ]
    })
  })
}
