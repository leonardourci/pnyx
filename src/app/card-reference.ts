import type { Card } from '#tasks/model.ts'
import { sourceFacts } from '#tasks/observations.ts'

const LIST_LIMIT = 100
const UNREFERENCED = [
  'steering',
  'externalSources',
  'statusLog',
  'notes',
  'replies',
  'brief',
  'initialPrompt',
  'intent',
  'progress',
  'projectRefresh',
  'launch',
  'settings',
  'copy',
] as const satisfies readonly (keyof Card)[]

export function cardReference({ card }: { card: Card }): Card {
  const reference: Card = {
    ...card,
    links: card.links.slice(-LIST_LIMIT),
    sourceRefs: sourceFacts({ refs: card.sourceRefs }),
  }

  if (card.asks) {
    reference.asks = card.asks.slice(-LIST_LIMIT)
  }

  for (const field of UNREFERENCED) {
    delete reference[field]
  }

  return reference
}
