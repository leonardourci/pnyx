import { statSync } from 'node:fs'
import type { HydraState } from '#app/model.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import { readTranscriptRecord } from '#workers/transcripts.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import { HYDRA_CARD } from './identity.ts'
import { messageReference } from './message-reference.ts'
import { hydraSessions, recordEntries, threadPath, type SessionEntry } from './transcripts-read.ts'

// Each read holds at most this much of a transcript, whatever the file's size.
const CHUNK_BYTES = 256 * 1024

export interface NativeSource {
  path: string
  session: string
  // Whether the history keeps Pnyx's own boundary messages, which only Hydra's sessions have.
  boundaries: boolean
}

// The transcripts a thread's messages come from, oldest session first: every session Hydra has had, or a task's current one.
export function nativeSources({
  state,
  card,
}: {
  state: HydraState
  card: string
}): NativeSource[] {
  if (card === HYDRA_CARD) {
    return hydraSessions({ state }).flatMap(({
      session,
      agent,
    }) => {
      const path = threadPath({ card: { agent } })

      return path ? [
        {
          path,
          session,
          boundaries: true,
        },
      ] : []
    })
  }

  const task = state.cards[card]
  const path = task && threadPath({ card: task })
  const session = task && cardSessionId({ card: task })

  return path && session ? [
    {
      path,
      session,
      boundaries: false,
    },
  ] : []
}

function entriesOf({
  source,
  record,
  offset,
}: {
  source: NativeSource
  record: unknown
  offset: number
}): SessionEntry[] {
  return recordEntries({
    record,
    offset,
    tools: false,
    thinking: false,
    boundaries: source.boundaries,
  }).map(item => ({
    ...item,
    reference: messageReference({
      session: source.session,
      id: item.id,
      messageId: item.messageId,
    }),
    session: source.session,
  }))
}

const recordTime = ({ record }: { record: unknown }) => {
  const parsed = readTranscriptRecord({ record })
  const time = Date.parse(parsed.messages[0]?.at ?? parsed.at ?? '')

  return Number.isNaN(time) ? undefined : time
}

// The first line start at or after offset whose record has a time, with that time; undefined when none follows it.
function probe({
  path,
  offset,
}: {
  path: string
  offset: number
}): {
  start: number
  time: number
} | undefined {
  let position = offset
  let read = readTranscript({
    cursor: {
      source: path,
      identity: '',
      pos: position,
    },
    maxBytes: CHUNK_BYTES,
  })

  while (read && read.end > position) {
    for (const line of read.lines) {
      const time = recordTime({ record: line.record })

      if (time !== undefined) {
        return {
          start: line.pos,
          time,
        }
      }
    }

    position = read.end
    read = readTranscript({
      cursor: {
        source: path,
        identity: '',
        pos: position,
      },
      maxBytes: CHUNK_BYTES,
    })
  }

  return undefined
}

// A byte offset at or before the first record timed at or after time. Transcripts only grow at the end, so their records
// are in time order and a halving search finds it without reading the file.
function offsetAt({
  path,
  time,
}: {
  path: string
  time: number
}): number {
  const size = statSync(
    path,
    { throwIfNoEntry: false },
  )?.size ?? 0
  let low = 0
  let high = size

  while (high - low > CHUNK_BYTES) {
    const middle = Math.floor((low + high) / 2)
    // The line the middle falls inside is skipped, so the probe begins at the next line.
    const read = readTranscript({
      cursor: {
        source: path,
        identity: '',
        pos: middle,
      },
      maxBytes: 1,
    })
    const found = read && read.end > middle ? probe({
      path,
      offset: read.end,
    }) : undefined

    if (found && found.time < time) {
      low = found.start
    } else {
      high = middle
    }
  }

  return low
}

// The messages a thread's transcripts hold timed from `from` up to but excluding `to`, in time order. Only the transcript
// bytes in between are read, a chunk at a time.
export function nativeWindow({
  sources,
  from,
  to,
}: {
  sources: NativeSource[]
  from?: number
  to?: number
}): SessionEntry[] {
  const found: SessionEntry[] = []

  for (const source of sources) {
    let position = from === undefined ? 0 : offsetAt({
      path: source.path,
      time: from,
    })
    let finished = false

    while (!finished) {
      const read = readTranscript({
        cursor: {
          source: source.path,
          identity: '',
          pos: position,
        },
        maxBytes: CHUNK_BYTES,
      })

      if (!read || read.end === position) {
        break
      }

      position = read.end

      for (const line of read.lines) {
        for (const entry of entriesOf({
          source,
          record: line.record,
          offset: line.pos,
        })) {
          const time = Date.parse(entry.at ?? '')

          if (Number.isNaN(time)) {
            continue
          }

          if (to !== undefined && time >= to) {
            finished = true

            break
          }

          if (from === undefined || time >= from) {
            found.push(entry)
          }
        }

        if (finished) {
          break
        }
      }
    }
  }

  return found
}

export function nativeRecord({
  source,
  offset,
}: {
  source: NativeSource
  offset: number
}): SessionEntry[] {
  const read = readTranscript({
    cursor: {
      source: source.path,
      identity: '',
      pos: offset,
    },
    maxBytes: CHUNK_BYTES,
  })
  const line = read?.lines.find(candidate => candidate.pos === offset)

  return line ? entriesOf({
    source,
    record: line.record,
    offset,
  }) : []
}
