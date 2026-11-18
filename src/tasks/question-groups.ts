import type { HydraState } from '#app/model.ts'
import type { Card } from './model.ts'
import { openDecisions, type OpenDecision } from './decisions.ts'

export interface QuestionGroup {
  card: Pick<Card, 'id' | 'title'>
  decisions: OpenDecision[]
  choices: string[]
}

export const decisionKey = ({ decision }: { decision: OpenDecision }) => `${decision.card.id}/${decision.id}/${decision.at ?? ''}`

export function ownerQuestionGroups({ state }: { state: HydraState }): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>()

  for (const decision of openDecisions({ state })) {
    if (decision.kind !== 'owner question' && decision.kind !== 'permission' && decision.kind !== 'blocking prompt') {
      continue
    }

    const task = state.cards[decision.card.id]!
    const parent = task.parentId && state.cards[task.parentId]
    const card = parent || task
    const group = groups.get(card.id) ?? {
      card,
      decisions: [],
      choices: [],
    }
    group.decisions.push(decision)
    groups.set(
      card.id,
      group,
    )
  }

  for (const group of groups.values()) {
    const asks = group.decisions.map(decision => decision.kind === 'owner question'
      ? state.cards[decision.card.id]?.asks?.find(ask => ask.id === decision.id) : undefined)
    const options = asks[0]?.options ?? []
    group.choices = options.filter(option => asks.every(ask => ask?.options?.some(candidate =>
      candidate.label === option.label && candidate.description === option.description)))
      .map(option => option.label)
  }

  return [...groups.values()]
}
