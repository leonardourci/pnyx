import type { Card } from './model.ts'
import type { TitanState } from '#app/model.ts'
import { completedOutcome } from '#tasks/delivery/model.ts'
import { TITAN_CARD } from '#titan/identity.ts'

const known = new WeakMap<Record<string, Card>, {
  references: Record<string, Card>
  cards: Record<string, Card>
}>()

export function isManagedTask({ card }: { card: Card }): boolean {
  return card.id === TITAN_CARD
}

// Every card a lookup by id may name. On the page, this includes the reference copies of hidden tasks.
export function knownCards({ state }: { state: TitanState }): Record<string, Card> {
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
  return card.hidden !== true
}

export const taskDone = ({ card }: { card: Card }): boolean =>
  completedOutcome({ outcome: card.outcome })

export function rankOf({ card }: { card: Pick<Card, 'rank' | 'createdSeq'> }): number {
  return card.rank ?? card.createdSeq
}

// The rank that puts a card at position `at` among the other cards of its new column.
export function rankWithin({
  card,
  others,
  at,
}: {
  card: Pick<Card, 'rank' | 'createdSeq'>
  others: Card[]
  at: number
}): number {
  const next = others[at], previous = others[at - 1]

  // ponytail: midpoint ranks run out of float precision after ~50 drops into one gap; renumber the column if that ever bites.
  return next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
    : next ? rankOf({ card: next }) - 1
      : previous ? rankOf({ card: previous }) + 1 : rankOf({ card })
}
