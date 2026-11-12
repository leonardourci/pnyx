import type { Card } from './model.ts'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

const known = new WeakMap<Record<string, Card>, {
  references: Record<string, Card>
  cards: Record<string, Card>
}>()

export function isManagedTask({ card }: { card: Card }): boolean {
  return Boolean(card.automaticTask) || card.id === HYDRA_CARD
}

// Every card a lookup by id may name: on the page that adds the reference copies of hidden tasks.
export function knownCards({ state }: { state: HydraState }): Record<string, Card> {
  const references = state.references

  if (!references) {
    return state.cards
  }

  const cached = known.get(state.cards)

  if (cached?.references === references) {
    return cached.cards
  }

  const cards = {
    ...references,
    ...state.cards,
  }
  known.set(
    state.cards,
    {
      references,
      cards,
    },
  )

  return cards
}

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

// The rank that puts a card at position `at` among the other cards of its new column.
export function rankWithin({
  card,
  others,
  at,
}: {
  card: Card
  others: Card[]
  at: number
}): number {
  const next = others[at], previous = others[at - 1]

  // ponytail: midpoint ranks run out of float precision after ~50 drops into one gap; renumber the column if that ever bites.
  return next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
    : next ? rankOf({ card: next }) - 1
      : previous ? rankOf({ card: previous }) + 1 : rankOf({ card })
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
