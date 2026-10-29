import type { HydraColumn } from '#tasks/columns-model.ts'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { cardDoneDeadline, HOUR_MS } from '#tasks/retention-rules.ts'
import { elapsedTime } from '#web-shared/time.ts'
import { cardStatus, type CardStatus } from '#tasks/card-status.ts'

// A column's icon and color come from its role; a custom column has its own icon.
export const columnLook = ({ column }: { column: Pick<HydraColumn, 'id' | 'role'> }) => ({
  icon: column.role ?? (column.id.startsWith('custom:') ? 'custom' : column.id),
  tone: `column-${column.role ?? column.id}`,
})

export const columnsFor = ({ state }: { state: HydraState }) => {
  return hydraConfig({ state }).columns
}

export function filterCards({
  state,
  workspace,
  tag,
  query = '',
}: {
  state: HydraState
  workspace: string
  tag: string
  query?: string
}): Card[] {
  const words = query.toLowerCase().trim()
    .split(/\s+/)
    .filter(Boolean)

  return Object.values(state.cards).filter(c => liveTask({ card: c })
    && (!workspace || c.workspace === workspace)
    && (!tag || c.tags.includes(tag))
    && words.every(w => [
      c.title,
      c.project ?? '',
      c.key,
      ...c.tags,
      ...c.links.map(l => `${l.number ?? ''} ${l.title ?? ''}`),
    ].join(' ').toLowerCase()
      .includes(w)))
    .sort((
      a,
      b,
    ) => rankOf({ card: a }) - rankOf({ card: b }) || a.id.localeCompare(b.id))
}

// The "Find a card" box: every card the filter above matches, in its order, then
// the other cards the Hydra's search found, best first, within the same workspace
// and tag filters.
export function findBoxCards(
  {
    state,
    workspace,
    tag,
    query,
    meaning: found,
  }: {
    state: HydraState
    workspace: string
    tag: string
    query: string
    meaning: string[]
  },
): Card[] {
  const local = filterCards({
    state,
    workspace,
    tag,
    query,
  })
  const seen = new Set(local.map(c => c.id))

  return [
    ...local,
    ...found.map(id => state.cards[id]).filter((c): c is Card =>
      !!c && liveTask({ card: c }) && !seen.has(c.id)
    && (!workspace || c.workspace === workspace) && (!tag || c.tags.includes(tag))),
  ]
}

export function visibleParent({
  card,
  visible,
}: {
  card: Card
  visible: Card[]
}): Card | undefined {
  return visible.find(c => c.id === card.parentId)
}

export const shownActivity = ({ card }: { card: Card }) =>
  card.sessionActivity && card.sessionActivity !== 'ended' ? card.sessionActivity : card.activity

// The card a dragged task goes above when dropped on `over`: `over` itself, or the
// next card when dropped on its lower half. Undefined means the end of the column.
export function dropBefore({
  cards,
  over,
  below,
}: {
  cards: Card[]
  over?: string
  below: boolean
}): string | undefined {
  const index = cards.findIndex(c => c.id === over)

  return index < 0 ? undefined : cards[below ? index + 1 : index]?.id
}

export function taskLabel({ card }: { card: Card }): string {
  if (card.status) {
    return `${card.status.state.replaceAll(
      '_',
      ' ',
    )}${card.status.note ? `: ${card.status.note}` : ''}`
  }

  return shownActivity({ card })
    ?? card.outcome?.state ?? (card.tracking ? 'No status' : 'Activity unknown')
}

export function cardState({
  card,
  hours,
  now,
}: {
  card: Card
  hours?: number
  now: number
}): CardStatus {
  const status = cardStatus({ card })

  if (status.kind === 'done' && card.doneAt) {
    const deadline = cardDoneDeadline({
      card,
      hours,
    })
    const remaining = deadline === undefined ? undefined : deadline - now

    return {
      ...status,
      text: remaining !== undefined && remaining <= 6 * HOUR_MS
        ? `hidden in ${remaining > HOUR_MS ? `${Math.ceil(remaining / HOUR_MS)}h` : `${Math.max(
          1,
          Math.ceil(remaining / 60_000),
        )}m`}`
        : `done · ${elapsedTime({
          at: card.doneAt,
          now,
        })}`,
    }
  }

  if (status.kind === 'stopped' && status.at) {
    return {
      ...status,
      text: `stopped · ${elapsedTime({
        at: status.at,
        now,
      })}`,
    }
  }

  return status
}

export function expandedByColumn({
  ids,
  cards,
  pending,
}: {
  ids: string[]
  cards: Record<string, Card>
  pending: Record<string, string>
}): string[] {
  const columnOf = ({ id }: { id: string }) => cards[id]?.column ?? pending[id] ?? id
  const open = new Set<string>(), kept: string[] = []

  for (const id of [...ids].reverse()) {
    const column = columnOf({ id })

    if (!open.has(column)) {
      open.add(column)
      kept.push(id)
    }
  }

  return kept.reverse()
}
