import type { Card } from '#tasks/model.ts'
import { completedOutcome, type OutcomeEvent } from './model.ts'

// Done or cancelled starts the hide clock; older logs' hooks "ended" and "failed" are no task state, so they clear it.
export function applyOutcome({
  card,
  event,
}: {
  card: Card
  event: OutcomeEvent
}): void {
  const after = event.data.after

  if (!after || !completedOutcome({ outcome: after })) {
    delete card.outcome
    delete card.doneAt
    delete card.keepDone

    if (card.expired) {
      delete card.hidden
      delete card.expired
    }

    return
  }

  const alreadyClosed = completedOutcome({ outcome: card.outcome })
  card.outcome = after

  if (!alreadyClosed) {
    card.doneAt = event.at
  }

  const closes = new Set(event.data.closes)

  if (!closes.size) {
    return
  }

  card.asks = card.asks?.map(ask => closes.has(ask.id) && !ask.closed ? {
    ...ask,
    closed: {
      id: event.id,
      at: event.at,
      reason: `task marked ${after.state}`,
      evidence: event.id,
    },
  } : ask)
}
