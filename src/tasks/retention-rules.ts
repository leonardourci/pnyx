import { openAsks } from './ask-state.ts'
import { reportReviewGaps } from '#investigations/inventory.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from './model.ts'
import type { DoneAfterHours } from '#settings/model.ts'
import { isManagedTask } from './select.ts'

export const DEFAULT_DONE_HOURS = 24
export const MAX_DONE_HOURS = 876000
export const HOUR_MS = 60 * 60 * 1000

// `task hide-after` hours: 0 to MAX_DONE_HOURS, null for `default` (the shared setting), undefined for a value it refuses.
export function hideAfterHours({ value }: { value: string }): number | null | undefined {
  const raw = value.trim()

  if (raw === 'default') {
    return null
  }

  const hours = Number(raw)

  return raw && Number.isFinite(hours) && hours >= 0 && hours <= MAX_DONE_HOURS ? hours : undefined
}

export function refreshDone({
  state,
  at,
}: {
  state: HydraState
  at: string
}): void {
  for (const card of Object.values(state.cards)) {
    const done = state.config?.columns.find(c => c.id === card.column)?.role === 'done'
      || (!state.config && card.column === 'done')

    if (done && !isManagedTask({ card })) {
      card.doneAt ??= at
    } else {
      delete card.doneAt
      delete card.keepDone

      if (card.expired) {
        delete card.hidden
        delete card.expired
      }
    }
  }
}

// A task's own 0 keeps it visible; the shared setting says that with off, so its 0 hides right away.
export function cardDoneDeadline({
  card,
  hours = DEFAULT_DONE_HOURS,
}: {
  card: Card
  hours?: DoneAfterHours
}): number | undefined {
  const delay = card.doneAfterHours ?? hours
  const kept = card.doneAfterHours === 0 || delay === 'off'
  const pendingOwnerChoice = openAsks({
    card,
    audience: 'owner',
  }).length > 0

  if (pendingOwnerChoice || card.hidden || card.keepDone || !card.doneAt || kept) {
    return undefined
  }

  const deadline = Date.parse(card.doneAt) + delay * HOUR_MS

  return Number.isFinite(deadline) ? deadline : undefined
}

export function doneDeadline({
  state,
  hours,
}: {
  state: HydraState
  hours: DoneAfterHours
}): number | undefined {
  let next: number | undefined

  for (const card of Object.values(state.cards)) {
    if (reportReviewGaps({
      state,
      card,
    }).length) {
      continue
    }

    const deadline = cardDoneDeadline({
      card,
      hours,
    })

    if (deadline !== undefined) {
      next = Math.min(
        next ?? deadline,
        deadline,
      )
    }
  }

  return next
}
