import type { HydraState, Decision } from '../app/model.ts'
import type { RepliedEvent } from '../tasks/model.ts'
import { base, type Meta } from '../app/command-meta.ts'
import { findCard } from '../tasks/push-rules.ts'
import { decided } from '../app/decision.ts'

export function decideReply({
  state,
  ref,
  data,
  meta,
}: {
  state: HydraState
  ref: string
  data: RepliedEvent['data']
  meta: Meta
}): Decision {
  const card = findCard({
    state,
    ref,
  })

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.replied',
      data,
    },
  })
}
