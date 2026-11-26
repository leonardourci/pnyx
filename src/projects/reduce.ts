import type { TitanEvent, TitanState } from '#app/model.ts'
import { touch } from '#tasks/touch.ts'

export function applyProject({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'titan.project') {
    state.projects = [
      ...(state.projects ?? []).filter(p => p.path !== event.data.after.path),
      structuredClone(event.data.after),
    ]
    state.projectsRevision = (state.projectsRevision ?? 0) + 1

    return true
  }

  if (event.type === 'task.project') {
    const card = state.cards[event.cardId]

    if (card) {
      if (event.data.after === null) {
        delete card.project
      } else {
        card.project = event.data.after
      }

      touch({
        card,
        event,
      })
    }

    return true
  }

  return false
}
