import type { Card } from './model.ts'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'

export function liveTask({ card }: { card: Card }): boolean {
  return card.hidden !== true && !card.automaticTask
}

// Declared done by its worker, or moved into a done column.
export function taskDone({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): boolean {
  const doneColumns = hydraConfig({ state }).columns.filter(column => column.role === 'done')
    .map(column => column.id as string)

  return card.status?.state === 'done' || doneColumns.includes(card.column)
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
