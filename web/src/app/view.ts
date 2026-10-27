import type { HydraState } from '../../../src/app/model.ts'
import { liveTask } from '../../../src/core/tasks.ts'

export const hydraTitle = ({ name }: { name: string }) => name || 'Untitled'

export function pageTitle({
  cards,
  selected = null,
  needsYou = 'needs_you',
}: {
  cards: HydraState['cards']
  selected?: string | null
  needsYou?: string
}): string {
  const count = Object.values(cards)
    .filter(c => liveTask({ card: c }) && c.column === needsYou).length
  const label = (selected && cards[selected]?.title) || 'Hydra'

  return `${count > 0 ? `(${count}) ` : ''}${label} · Pnyx`
}

export const receiptLabel = ({ state }: { state: string }) => ({
  queued: 'Queued',
  delivered: 'Delivered',
  delivery_unknown: 'Delivery unknown',
  failed: 'Delivery failed',
}[state] ?? state)

export const shouldReload = ({
  loaded,
  server,
}: {
  loaded: string | undefined
  server: string
}) =>
  Boolean(loaded && server && loaded !== server)
