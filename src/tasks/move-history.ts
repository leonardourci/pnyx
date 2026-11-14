import type { HydraEvent } from '#app/model.ts'
import { scanEvents } from '#app/event-log.ts'

export interface HistoryEntry {
  hydra: string
  event: HydraEvent
}

// Newest first, following the id both sides of a move share back through each Hydra the card left.
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
  matches({ event }: { event: HydraEvent }): boolean
}): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  let hydra: string | undefined = hydraId
  let upTo = Number.POSITIVE_INFINITY
  let events = [
    ...scanEvents({
      hydraId,
      cardIds: cards,
      types: types ? [
        ...types,
        'task.moved-in',
        'task.moved-out',
      ] : undefined,
    }),
  ]

  while (hydra) {
    const stay = events.filter(event => event.seq <= upTo)
    const arrival = stay.findLast(event => event.type === 'task.moved-in' && event.cardId === task)
    const since = arrival?.seq ?? 0
    const part = stay.filter(event => event.seq >= since && matches({ event }))

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
    events = [
      ...scanEvents({
        hydraId: from,
        cardIds: cards,
        types: types ? [
          ...types,
          'task.moved-in',
          'task.moved-out',
        ] : undefined,
      }),
    ]
    const departure = events.find(event => event.id === arrival.id && event.type === 'task.moved-out')
    hydra = departure ? from : undefined
    upTo = departure?.seq ?? 0
  }

  return entries
}
