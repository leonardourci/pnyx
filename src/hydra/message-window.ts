import type { HydraEvent } from '#app/model.ts'
import { eventPositions, eventTime, readEvents } from '#app/event-log.ts'
import { positionKey } from './history.ts'
import { nativeWindow, type NativeSource } from './native-window.ts'
import type { SessionEntry } from './transcripts-read.ts'

// A thread's events and transcript messages recorded at log positions after lo, up to and including hi. The events come
// from an index range of that size, and the transcripts are read only between the times of those two positions.
export function messageWindow({
  hydraId,
  sources,
  cardId,
  types,
  lo,
  hi,
}: {
  hydraId: string
  sources: NativeSource[]
  cardId?: string
  types: string[]
  lo: number
  hi: number
}): {
  events: HydraEvent[]
  native: SessionEntry[]
  positions: Map<string, number>
} {
  const events = readEvents({
    hydraId,
    cardId,
    types,
    after: lo,
    before: hi + 1,
  })
  const start = lo > 0 ? eventTime({
    hydraId,
    seq: lo,
  }) : undefined
  const end = eventTime({
    hydraId,
    seq: hi,
  })
  const read = end === undefined || sources.length === 0 ? [] : nativeWindow({
    sources,
    from: start === undefined ? undefined : Date.parse(start),
    to: Date.parse(end),
  })
  const found = eventPositions({
    hydraId,
    entries: read.map(entry => ({
      id: positionKey({ entry }),
      at: entry.at,
    })),
  })
  const native = read.filter(entry => {
    const seq = found.get(positionKey({ entry }))

    return seq !== undefined && seq > lo && seq <= hi
  })

  return {
    events,
    native,
    positions: found,
  }
}
