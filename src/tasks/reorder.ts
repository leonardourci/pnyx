import type { TitanState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { decided } from '#app/decision.ts'
import { findCard } from './push-rules.ts'
import { rankOf } from './select.ts'
import { taskRank } from './order.ts'

export function reorderTask({
  state,
  ref,
  before,
  meta,
}: {
  state: TitanState
  ref: string
  before?: string
  meta: Meta
}): Decision {
  const card = findCard({
    state,
    ref,
  })
  const rank = taskRank({
    state,
    card,
    before,
  })

  if (rank === rankOf({ card })) {
    return { skipped: 'unchanged' }
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
      type: 'task.edited',
      data: {
        key: card.key,
        rank,
        before: { rank: card.rank ?? null },
      },
    },
  })
}
