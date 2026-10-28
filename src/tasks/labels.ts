import type { HydraEvent, HydraState } from '../app/model.ts'
import type { SavedLabelColor } from './model.ts'

export function labelsForEvent({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): string[] {
  const labels = Object.values(state.cards)
    .flatMap(card => [
      ...(card.project ? [card.project] : []),
      ...card.tags,
    ])

  if (event.type === 'card.pushed') {
    labels.push(
      ...(event.data.project ? [event.data.project] : []),
      ...(event.data.tags ?? []),
    )
  } else if (event.type === 'task.created' && event.data.project) {
    labels.push(event.data.project)
  } else if (event.type === 'task.project' && event.data.after) {
    labels.push(event.data.after)
  } else if (event.type === 'hydra.project') {
    labels.push(event.data.after.path)
  }

  return [
    ...new Set([
      ...labels,
      ...(state.projects ?? []).map(project => project.path),
    ]),
  ]
}

export function applyLabelColors({
  state,
  colors,
}: {
  state: HydraState
  colors?: SavedLabelColor[]
}): void {
  if (!colors?.length) {
    return
  }

  const saved = new Map((state.labelColors ?? []).map(entry => [
    entry.label,
    entry,
  ]))

  for (const entry of colors) {
    if (!saved.has(entry.label)) {
      saved.set(
        entry.label,
        { ...entry },
      )
    }
  }

  state.labelColors = [...saved.values()]
}
