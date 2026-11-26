import type { TitanEvent } from '#app/model.ts'
import { scanEvents } from '#app/event-log.ts'

export interface HistoryEntry {
  titan: string
  event: TitanEvent
}

// Newest first, following the id both sides of a move share back through each Titan the card left.
export function movedHistory({
  titanId,
  task,
  matches,
  types,
  cards = [task],
}: {
  titanId: string
  task: string
  cards?: string[]
  types?: string[]
  matches({ event }: { event: TitanEvent }): boolean
}): HistoryEntry[] {
  return [
    ...scanEvents({
      titanId,
      cardIds: cards,
      types,
      descending: true,
    }),
  ]
    .filter(event => matches({ event })).map(event => ({
      titan: event.titanId ?? titanId,
      event,
    }))
}
