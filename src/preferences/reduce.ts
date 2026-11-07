import type { HydraEvent, HydraState } from '#app/model.ts'
import { refreshTasks } from '#tasks/columns.ts'
import { touch } from '#tasks/touch.ts'

export function applyView({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'board.view') {
    state.view = structuredClone(event.data.after)
    state.viewRevision = (state.viewRevision ?? 0) + 1

    for (const placement of event.data.placements ?? []) {
      const placed = state.cards[placement.cardId]

      if (!placed) {
        continue
      }

      if (placement.after) {
        placed.column = placement.after
      }

      touch({
        card: placed,
        event,
      })
    }

    refreshTasks({ state })

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  return false
}
