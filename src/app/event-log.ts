import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs'
import { HydraError } from '../store/errors.ts'
import { EVENT_VERSION } from '../store/events.ts'
import { EVENT_TYPES, type HydraEvent } from './model.ts'
import { logPath } from '../store/storage.ts'
import { hydraDir } from './home-migration.ts'

export interface LogRead {
  events: HydraEvent[]
  // Byte offset just past the last complete line.
  end: number
  size: number
}

// Appended by repair after it closes a torn line with a newline. Readers skip the
// line it names; it is not a Hydra event and takes no sequence number.
export interface RepairMarker {
  v: typeof EVENT_VERSION
  type: 'log.repaired'
  at: string
  data: {
    offset: number
    length: number
  }
}

function parseLine({ line }: { line: string }): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function repairMarker({ value }: { value: unknown }): RepairMarker | undefined {
  const m = value as Partial<RepairMarker> | undefined

  return m?.type === 'log.repaired' && Number.isInteger(m.data?.offset) && Number.isInteger(m.data?.length)
    ? m as RepairMarker
    : undefined
}

function corrupt({ offset }: { offset: number }): HydraError {
  return new HydraError({
    message: `events.jsonl is corrupt at byte ${offset}`,
    code: 'LOG_CORRUPT',
    help: ['The log is never rewritten automatically; inspect that line by hand'],
  })
}

function toEvent({
  event,
  offset,
}: {
  event: unknown
  offset: number
}): HydraEvent {
  const e = event as Partial<HydraEvent> | undefined

  if (
    typeof e !== 'object' ||
    e === null ||
    !Number.isInteger(e.seq) ||
    typeof e.id !== 'string' ||
    typeof e.cardId !== 'string' ||
    !EVENT_TYPES.includes(e.type as HydraEvent['type'])
  ) {
    throw corrupt({ offset })
  }

  if (e.v !== EVENT_VERSION) {
    throw new HydraError({
      message: `event at byte ${offset} has schema v${e.v}; this pnyx-axi reads v${EVENT_VERSION}`,
      code: 'UNSUPPORTED_VERSION',
    })
  }

  return e as HydraEvent
}

// Reads complete lines from `from`. Bytes after the last newline are a torn tail
// left by a crash mid-append: they are reported through `end` < `size`, never parsed.
// A line named by the repair marker right after it is skipped, whatever it holds.
export function readLog({
  dir,
  from = 0,
}: {
  dir: string
  from?: number
}): LogRead | null {
  const path = logPath({ dir })

  if (!existsSync(path)) {
    return from === 0 ? {
      events: [],
      end: 0,
      size: 0,
    } : null
  }

  const fd = openSync(
    path,
    'r',
  )

  try {
    const size = fstatSync(fd).size

    if (from > size) {
      return null
    }

    const buf = Buffer.alloc(size - from)
    readSync(
      fd,
      buf,
      0,
      buf.length,
      from,
    )
    const complete = buf.lastIndexOf(10) + 1
    const events: HydraEvent[] = []
    let previous: {
      offset: number
      length: number
      event?: HydraEvent
      error?: HydraError
    } | undefined

    for (let start = 0; start < complete; ) {
      const end = buf.indexOf(
        10,
        start,
      )
      const offset = from + start
      const line = buf.toString(
        'utf8',
        start,
        end,
      )
      const length = end - start
      start = end + 1

      if (line.trim() === '') {
        continue
      }

      const value = parseLine({ line })

      const marker = repairMarker({ value })

      if (marker) {
        if (previous?.offset !== marker.data.offset || previous.length !== marker.data.length) {
          throw corrupt({ offset })
        }

        if (previous.event) {
          events.pop()
        }

        previous = undefined
        continue
      }

      if (previous?.error) {
        throw previous.error
      }

      previous = {
        offset,
        length,
      }

      try {
        previous.event = toEvent({
          event: value,
          offset,
        })
        events.push(previous.event)
      } catch (error) {
        previous.error = error as HydraError
      }
    }

    if (previous?.error) {
      throw previous.error
    }

    return {
      events,
      end: from + complete,
      size,
    }
  } finally {
    closeSync(fd)
  }
}

// ponytail: the log only grows, so the server keeps every parsed event (65 MB of heap for a 45 MB log); index offsets per card if that is too much.
const parsed = new Map<string, {
  file: string
  events: HydraEvent[]
  end: number
}>()

export function readInitialEvent({ hydraId }: { hydraId: string }): HydraEvent | null {
  let fd: number

  try {
    fd = openSync(
      logPath({ dir: hydraDir({ hydraId }) }),
      'r',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  try {
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(4096)

    for (;;) {
      const bytes = readSync(
        fd,
        buffer,
        0,
        buffer.length,
        null,
      )

      if (!bytes) {
        return null
      }

      const chunk = buffer.subarray(
        0,
        bytes,
      )
      const newline = chunk.indexOf(10)

      if (newline !== -1) {
        chunks.push(chunk.subarray(
          0,
          newline,
        ))

        return toEvent({
          event: parseLine({ line: Buffer.concat(chunks).toString('utf8') }),
          offset: 0,
        })
      }

      chunks.push(Buffer.from(chunk))
    }
  } finally {
    closeSync(fd)
  }
}

export function readEvents({ hydraId }: { hydraId: string }): HydraEvent[] {
  const dir = hydraDir({ hydraId })
  let file: string

  try {
    const {
      dev,
      ino,
      birthtimeMs,
    } = statSync(logPath({ dir }))
    file = `${dev}:${ino}:${birthtimeMs}`
  } catch {
    parsed.delete(dir)

    return []
  }

  const cached = parsed.get(dir)
  let log: {
    events: HydraEvent[]
    end: number
  } | null = null

  if (cached?.file === file) {
    try {
      const next = readLog({
        dir,
        from: cached.end,
      })
      log = next && {
        events: cached.events.concat(next.events),
        end: next.end,
      }
    } catch {
      // A repair marker for a line before `end` needs the whole log.
    }
  }

  log ??= readLog({ dir }) ?? {
    events: [],
    end: 0,
  }
  parsed.set(
    dir,
    {
      file,
      ...log,
    },
  )

  return log.events.slice()
}

// Complete events at or after byte `offset`, and the offset just past them.
// Null when the log is now shorter than `offset`, so the reader must start over.
export function readEventsFrom(
  {
    hydraId,
    offset,
  }: {
    hydraId: string
    offset: number
  },
): {
  events: HydraEvent[]
  end: number
} | null {
  const log = readLog({
    dir: hydraDir({ hydraId }),
    from: offset,
  })

  return log && {
    events: log.events,
    end: log.end,
  }
}
