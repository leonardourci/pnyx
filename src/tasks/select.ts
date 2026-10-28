import type { Card } from './model.ts'
import type { HydraState } from '#app/model.ts'

export function liveTask({ card }: { card: Card }): boolean {
  return card.hidden !== true && !card.automaticTask
}

export function rankOf({ card }: { card: Card }): number {
  return card.rank ?? card.createdSeq
}

export function columnCards({
  state,
  column,
}: {
  state: HydraState
  column: string
}): Card[] {
  return Object.values(state.cards)
    .filter(c => liveTask({ card: c }) && c.column === column)
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }) || a.id.localeCompare(b.id))
}
