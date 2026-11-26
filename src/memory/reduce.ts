import type { TitanEvent, TitanState } from '#app/model.ts'

export function applyMemory({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'titan.memory') {
    state.hydraMemory ??= {}

    if (event.data.after === null) {
      delete state.hydraMemory[event.data.key]
    } else {
      state.hydraMemory[event.data.key] = {
        text: event.data.after,
        at: event.at,
      }
    }

    return true
  }

  return false
}
