import type { HydraState, Decision } from '../app/model.ts'
import type { Column } from './columns-model.ts'
import { fallbackColumn } from './column-rules.ts'
import { hydraConfig } from '../hydra/config.ts'
import { invalid } from '../app/command-validation.ts'
import { base, type Meta } from '../app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { columnCards, rankOf } from './select.ts'
import { decided } from '../app/decision.ts'
import type { ViewPreferences, ViewEvent } from '../preferences/model.ts'

export function checkColumn({
  state,
  column,
}: {
  state: HydraState
  column: Column | null
}): void {
  if (column && !hydraConfig({ state }).columns.some(c => c.id === column)) {
    throw invalid({ message: `unknown Hydra column: ${column}` })
  }
}

export function decideMove(
  {
    state,
    ref,
    column,
    before,
    meta,
  }: {
    state: HydraState
    ref: string
    column: Column
    before?: string
    meta: Meta
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  checkColumn({
    state,
    column,
  })
  const others = columnCards({
    state,
    column,
  }).filter(c => c.id !== card.id)
  const above = before === undefined ? undefined : findCard({
    state,
    ref: before,
  }).id
  const at = above === undefined ? others.length : others.findIndex(c => c.id === above)

  if (above === card.id) {
    throw invalid({ message: 'a card cannot go before itself' })
  }

  if (at < 0) {
    throw invalid({ message: `card ${before} is not in column ${column}` })
  }

  const next = others[at], previous = others[at - 1]
  // ponytail: midpoint ranks run out of float precision after ~50 drops into one gap; renumber the column if that ever bites.
  const rank = next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
    : next ? rankOf({ card: next }) - 1
      : previous ? rankOf({ card: previous }) + 1 : rankOf({ card })

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.moved',
      data: {
        before: card.column,
        after: column,
        rank,
        beforeRank: rankOf({ card }),
      },
    },
  })
}

// Cards in a deleted legacy view column move to the fallback column; Hydra columns stay.
export function removedColumnPlacements({
  state,
  after,
}: {
  state: HydraState
  after: ViewPreferences
}): NonNullable<ViewEvent['data']['placements']> {
  const kept = new Set<Column>([
    ...after.customColumns.map(c => c.id),
    ...(state.config?.columns.map(c => c.id) ?? []),
  ])
  const columns = hydraConfig({
    state: {
      ...state,
      view: after,
    },
  }).columns
  const fallback = fallbackColumn({ columns })

  return Object.values(state.cards)
    .filter(c => c.column.startsWith('custom:') && !kept.has(c.column))
    .map(c => ({
      cardId: c.id,
      before: c.column,
      after: fallback,
      revision: c.revision,
    }))
}
