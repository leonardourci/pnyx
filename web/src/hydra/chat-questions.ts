import type { HydraState } from '#app/model.ts'
import type { Ask, Card } from '#tasks/model.ts'
import { activeAsks } from '#tasks/ask-state.ts'
import { canonicalMergeQuestion } from '#tasks/delivery/merge-questions.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { ownerActor } from '#app/actors.ts'
import { taskMentions } from '#hydra/mentions.ts'

export interface ChatDecision {
  id: string
  at: string
  card: Card
  ask: Ask
  blocker: boolean
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
  const latest = state.hydraMessages?.findLast(message => ownerActor({ actor: message.actor }) && message.action === 'send')
  const context = new Set([
    selectedTask,
    latest?.task,
    ...taskMentions({ text: latest?.text ?? '' }).map(mention => mention.id),
    ...taskMentions({ text: draft }).map(mention => mention.id),
  ])

  return Object.values(state.cards).flatMap(card => {
    const blocker = card.status?.state === 'blocked'
    const visible = card.id === HYDRA_CARD || blocker || context.has(card.id)

    if (!visible) {
      return []
    }

    return activeAsks({
      card,
      audience: 'owner',
    }).filter(ask => {
      if (ask.kind !== 'merge' || !ask.url) {
        return true
      }

      const canonical = canonicalMergeQuestion({
        state,
        card,
        url: ask.url,
      })

      return canonical?.card.id === card.id && canonical.ask.id === ask.id
    })
      .map(ask => ({
        id: `ask:${card.id}:${ask.id}`,
        at: ask.reaskedAt ?? ask.escalated?.at ?? ask.at,
        card,
        ask,
        blocker,
      }))
  })
}
