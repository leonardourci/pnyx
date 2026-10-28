import type { HydraState, Decision } from '../../app/model.ts'
import type { Outcome } from './model.ts'
import { base, type Meta } from '../../app/command-meta.ts'
import { findCard } from '../push-rules.ts'
import { HydraError } from '../../store/errors.ts'
import { decided } from '../../app/decision.ts'

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
    throw new HydraError({
      message: `card ${card.id}'s outcome comes from ${observed} and cannot be changed here`,
      code: 'SOURCE_OWNED',
      help: [`Run \`pnyx-axi move ${card.id} <column>\` to pin the card instead`],
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
