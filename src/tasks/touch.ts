import type { Card } from './model.ts'
import type { EventBase } from '#store/events.ts'

export function touch({
  card,
  event,
}: {
  card: Card
  event: Pick<EventBase, 'seq' | 'at'>
}): void {
  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at
}
