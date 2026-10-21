import type { Card, HydraState } from './model.ts'

export const DEFAULT_DONE_HOURS = 24
export const MAX_DONE_HOURS = 876000
export const HOUR_MS = 60 * 60 * 1000

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

    if (done && !card.automaticTask && card.id !== '$hydra') {
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

export function cardDoneDeadline({
  card,
  hours = DEFAULT_DONE_HOURS,
}: {
  card: Card
  hours?: number
}): number | undefined {
  const delay = card.doneAfterHours ?? hours

  if (card.hidden || card.keepDone || !card.doneAt || delay === 0) {
    return undefined
  }

  const deadline = Date.parse(card.doneAt) + delay * HOUR_MS

  return Number.isFinite(deadline) ? deadline : undefined
}

export function doneDeadline({ state }: { state: HydraState }): number | undefined {
  let next: number | undefined

  for (const card of Object.values(state.cards)) {
    const deadline = cardDoneDeadline({
      card,
      hours: state.config?.doneAfterHours,
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
