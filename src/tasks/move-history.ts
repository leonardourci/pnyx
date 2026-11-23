import type { TitanEvent } from '#app/model.ts'
import { scanEvents } from '#app/event-log.ts'

export interface HistoryEntry {
  hydra: string
  event: TitanEvent
}

// Newest first, following the id both sides of a move share back through each Titan the card left.
export function movedHistory({
  hydraId,
  task,
  matches,
  types,
  cards = [task],
}: {
  hydraId: string
  task: string
  cards?: string[]
  types?: string[]
  matches({ event }: { event: TitanEvent }): boolean
}): HistoryEntry[] {
  return [
    ...scanEvents({
      hydraId,
      cardIds: cards,
      types,
      descending: true,
    }),
  ]
    .filter(event => matches({ event })).map(event => ({
      hydra: event.boardId ?? hydraId,
      event,
    }))
}
