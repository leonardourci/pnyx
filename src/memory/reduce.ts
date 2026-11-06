import type { HydraEvent, HydraState } from '#app/model.ts'

export function applyMemory({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'hydra.memory') {
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
