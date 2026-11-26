import type { TitanEvent, TitanState } from '#app/model.ts'
import { titanConfig } from '#titan/config.ts'
import { upgradeMilestone } from './model.ts'

export function applyUpgrade({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}): boolean {
  if (event.type !== 'othrys.upgrade') {
    return false
  }

  state.upgrades = [
    ...(state.upgrades ?? []).filter(operation => operation.id !== event.data.id),
    structuredClone(event.data),
  ]

  const text = upgradeMilestone({ operation: event.data })
  const id = `milestone:upgrade:${event.data.id}`
  const messages = state.titanMessages ?? []

  // The line moves to where the upgrade ended; each step in between leaves it where it started.
  if (text && messages.find(message => message.id === id)?.text !== text) {
    state.titanMessages = [
      ...messages.filter(message => message.id !== id),
      {
        id,
        action: 'send',
        kind: 'divider',
        text,
        at: event.at,
        actor: 'othrys',
        titan: titanConfig({ state }).titan.id,
      },
    ]
  }

  return true
}
