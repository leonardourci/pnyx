import type { HydraEvent, HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { upgradeMilestone } from './model.ts'

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

  const text = upgradeMilestone({ operation: event.data })
  const id = `milestone:upgrade:${event.data.id}`
  const messages = state.hydraMessages ?? []

  // The line moves to where the upgrade ended; each step in between leaves it where it started.
  if (text && messages.find(message => message.id === id)?.text !== text) {
    state.hydraMessages = [
      ...messages.filter(message => message.id !== id),
      {
        id,
        action: 'send',
        kind: 'divider',
        text,
        at: event.at,
        actor: 'pnyx',
        hydra: hydraConfig({ state }).hydra.id,
      },
    ]
  }

  return true
}
