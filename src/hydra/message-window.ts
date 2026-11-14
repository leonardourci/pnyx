import type { HydraEvent } from '#app/model.ts'
import { eventPositions, eventTime, readEvents } from '#app/event-log.ts'
import { positionKey } from './history.ts'
import { nativeWindow, type NativeSource } from './native-window.ts'
import type { SessionEntry } from './transcripts-read.ts'

// A read holds at most this many transcript messages, unless they all share one log position.
export const NATIVE_LIMIT = 2000

export interface MessageWindow {
  events: HydraEvent[]
  native: SessionEntry[]
  positions: Map<string, number>
  // The log positions after lo, up to and including hi, the read covered: a part of the range asked for when the
  // transcripts held more messages than one read keeps.
  lo: number
  hi: number
}

// A thread's events and transcript messages recorded at log positions after lo, up to and including hi. The events come
// from an index range of that size, and the transcripts are read only between the times of those two positions. When
// they hold more than NATIVE_LIMIT messages the range halves, keeping the end the caller walks from: toward 'hi' the
// positions after lo, toward 'lo' the positions before hi.
export function messageWindow({
  hydraId,
  sources,
  cardId,
  types,
  lo,
  hi,
  toward = 'hi',
}: {
  hydraId: string
  sources: NativeSource[]
  cardId?: string
  types: string[]
  lo: number
  hi: number
  toward?: 'lo' | 'hi'
}): MessageWindow {
  let read: SessionEntry[] | undefined

  while (!read) {
    const start = lo > 0 ? eventTime({
      hydraId,
      seq: lo,
    }) : undefined
    const end = eventTime({
      hydraId,
      seq: hi,
    })

    if (end === undefined || sources.length === 0) {
      read = []

      continue
    }

    const single = hi - lo <= 1
    const window = nativeWindow({
      sources,
      from: start === undefined ? undefined : Date.parse(start),
      to: Date.parse(end),
      limit: single ? Infinity : NATIVE_LIMIT,
    })

    if (!window.exceeded) {
      read = window.entries

      continue
    }

    const half = Math.ceil((hi - lo) / 2)

    if (toward === 'hi') {
      hi = lo + half
    } else {
      lo = hi - half
    }
  }

  const events = readEvents({
    hydraId,
    cardId,
    types,
    after: lo,
    before: hi + 1,
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
    lo,
    hi,
  }
}
