import type { HydraEvent } from '#app/model.ts'
import { readEvents } from '#app/event-log.ts'

export interface HistoryEntry {
  hydra: string
  event: HydraEvent
}

// A moved task's history, newest first: this Hydra's events since the card arrived, then each earlier
// Hydra's events up to the move that took the card away, found by the id both sides of a move share.
export function movedHistory({
  hydraId,
  task,
  matches,
}: {
  hydraId: string
  task: string
  matches({ event }: { event: HydraEvent }): boolean
}): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  let hydra: string | undefined = hydraId
  let upTo = Number.POSITIVE_INFINITY
  let events = readEvents({ hydraId })

  while (hydra) {
    const stay = events.filter(event => event.seq <= upTo && matches({ event }))
    const arrival = stay.findLast(event => event.type === 'task.moved-in' && event.cardId === task)
    const part = arrival ? stay.filter(event => event.seq >= arrival.seq) : stay

    for (const event of part.reverse()) {
      entries.push({
        hydra,
        event,
      })
    }

    if (arrival?.type !== 'task.moved-in') {
      break
    }

    const from: string = arrival.data.from
    // A Hydra deleted since the move has no log, which leaves its part out.
    events = readEvents({ hydraId: from })
    const departure = events.find(event => event.id === arrival.id && event.type === 'task.moved-out')
    hydra = departure ? from : undefined
    upTo = departure?.seq ?? 0
  }

  return entries
}
