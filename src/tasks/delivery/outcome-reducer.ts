import type { Card } from '#tasks/model.ts'
import { completedOutcome, type OutcomeEvent } from './model.ts'

export function applyOutcome({
  card,
  event,
}: {
  card: Card
  event: OutcomeEvent
}): void {
  const after = event.data.after
  const hasTaskOutcome = completedOutcome({ outcome: after })

  if (!after || !hasTaskOutcome) {
    delete card.outcome
    delete card.doneAt
    delete card.keepDone

    if (card.expired) {
      delete card.hidden
      delete card.expired
    }

    return
  }

  const sameOutcome = card.outcome?.state === after.state
  card.outcome = after

  if (!sameOutcome || !card.doneAt) {
    card.doneAt = event.at
    delete card.keepDone
  }

  // An ended task settles the instructions its worker never read, so nothing keeps notifying it.
  for (const message of card.steering ?? []) {
    if (!message.ack) {
      message.stopped = true
    }
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
