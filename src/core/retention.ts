import type { HydraState } from './model.ts'

export const DEFAULT_DONE_HOURS = 24
export const MAX_DONE_HOURS = 876000
export const HOUR_MS = 60 * 60 * 1000

export function refreshDone({ state, at }: { state: HydraState; at: string }): void {
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

export function doneDeadline({ state }: { state: HydraState }): number | undefined {
  const hours = state.config?.doneAfterHours ?? DEFAULT_DONE_HOURS
  let next: number | undefined

  if (hours === 0) {
    return undefined
  }

  for (const card of Object.values(state.cards)) {
    if (!card.hidden && !card.keepDone && card.doneAt) {
      const deadline = Date.parse(card.doneAt) + hours * HOUR_MS

      if (Number.isFinite(deadline)) {
        next = Math.min(next ?? deadline, deadline)
      }
    }
  }

  return next
}
