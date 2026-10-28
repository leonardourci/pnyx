import { isDeepStrictEqual } from 'node:util'
import type { HydraState, HydraEvent, Decision } from './model.ts'
import type { Meta } from './command-meta.ts'
import { hydraConfig } from '#hydra/config.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { checkRevision, strip } from '#tasks/push-rules.ts'
import { reduce } from './reducer.ts'

export function decided({
  state,
  meta,
  event,
}: {
  state: HydraState
  meta: Meta
  event: HydraEvent
}): Decision {
  if (event.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const card = state.cards[event.cardId]
  const movedToDone = event.type === 'card.moved'
    && hydraConfig({ state }).columns.find(column => column.id === event.data.after)?.role === 'done'
  const completed = event.type === 'card.outcome' && event.data.after?.state === 'done'

  if (card && (movedToDone || completed)) {
    requireReportReview({
      state,
      card,
    })
  }

  checkRevision({
    card: state.cards[event.cardId],
    ifRevision: meta.ifRevision,
  })
  const before = strip({ card: state.cards[event.cardId] })
  // The reducer reads eventIds only for the duplicate check above; cloning them is half of each decision's cost.
  const reduced = reduce({
    state: {
      ...state,
      eventIds: {},
    },
    event,
  })
  const after = strip({ card: reduced.cards[event.cardId] })

  return before && isDeepStrictEqual(
    before,
    after,
  ) && isDeepStrictEqual(
    state.sessions,
    reduced.sessions,
  ) ? { skipped: 'unchanged' } : { event }
}
