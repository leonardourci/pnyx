import type { HydraEvent, HydraState } from '../core/model.ts'

export function applyUpgrade({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'pnyx.upgrade') {
    return false
  }

  state.upgrades = [
    ...(state.upgrades ?? []).filter(operation => operation.id !== event.data.id),
    structuredClone(event.data),
  ]

  return true
}
