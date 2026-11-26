import type { TitanEvent, TitanState } from '#app/model.ts'
import { workspaceLayout } from './workspace.ts'

export function applyView({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'titan.view') {
    state.view = structuredClone(event.data.after)
    Reflect.deleteProperty(
      state.view,
      'keyboard',
    )
    state.view.workspace = workspaceLayout({ input: state.view.workspace })
    state.viewRevision = (state.viewRevision ?? 0) + 1

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  return false
}
