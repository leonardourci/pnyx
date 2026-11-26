import type { TitanEvent, TitanState } from '#app/model.ts'

export function applyMemory({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type === 'titan.memory') {
    state.titanMemory ??= {}

    if (event.data.after === null) {
      delete state.titanMemory[event.data.key]
    } else {
      state.titanMemory[event.data.key] = {
        text: event.data.after,
        at: event.at,
      }
    }

    return true
  }

  return false
}
