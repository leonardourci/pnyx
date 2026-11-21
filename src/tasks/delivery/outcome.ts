import { inform } from '#app/command-notices.ts'
import type { HydraState, Decision } from '#app/model.ts'
import type { Outcome } from './model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decided } from '#app/decision.ts'

// source: the adapter observing this outcome. An observed outcome changes or
// clears only through the same source; a person may replace one hooks observed.
export function decideOutcome(
  {
    state,
    ref,
    outcome,
    meta,
    source,
  }: {
    state: HydraState
    ref: string
    outcome: Outcome | null
    meta: Meta
    source?: string
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  const observed = card.outcome?.source

  if (observed && source !== observed && !(source === undefined && observed === 'hooks')) {
    inform({
      task: card.id,
      reason: `Outcome from ${observed} replaced; a later observation can update it`,
      clear: `Use pnyx outcome ${card.id} --clear to clear the override`,
    })
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.outcome',
      data: {
        before: card.outcome ?? null,
        after: outcome && source ? {
          ...outcome,
          source,
        } : outcome,
        card: {
          title: card.title,
          workspace: card.workspace,
          tags: card.tags,
          links: card.links,
        },
      },
    },
  })
}
