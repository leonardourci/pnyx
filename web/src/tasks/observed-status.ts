import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { cardStatus, type CardStatus } from '#tasks/card-status.ts'
import { knownCards } from '#tasks/select.ts'

export interface ObservedStatus extends CardStatus {
  details: string
}

export function observedStatus({
  card,
  state,
}: {
  card: Card
  state?: HydraState
}): ObservedStatus {
  const status = cardStatus({
    card,
    cards: state && knownCards({ state }),
  })

  return {
    ...status,
    details: status.text,
  }
}
