import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from './push-rules.ts'
import { columnCards, rankWithin } from './select.ts'

export function createBeforeRank({
  state,
  column,
  before,
}: {
  state: HydraState
  column: string
  before: string
}): number {
  const target = findCard({
    state,
    ref: before,
  })
  const cards = columnCards({
    state,
    column,
  })
  const index = cards.findIndex(card => card.id === target.id)

  if (index < 0) {
    throw new HydraError({
      message: `card ${before} is not in column ${column}`,
      field: 'before',
      code: 'VALIDATION_ERROR',
    })
  }

  return rankWithin({
    card: target,
    others: cards,
    at: index,
  })
}
