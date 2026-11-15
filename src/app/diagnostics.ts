import { randomUUID } from 'node:crypto'
import { appendFileSync, createWriteStream, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { repeatedLine, flushRepeatedLines } from '#diagnostics/repeated-lines.ts'
import { logRequestId } from '#diagnostics/context.ts'
import { logFailure } from '#diagnostics/log-failure.ts'
import { pnyxHome } from '#store/paths.ts'
import { privateDir } from '#store/storage.ts'
import { LOG_FIELDS, logDay, logged, oneDecimal, TEXT_MAX, type LogLine, type LogMode } from './log-line.ts'

export type { LogLine, LogMode } from './log-line.ts'

const streams = new Map<string, {
  stream: WriteStream
  lines: Set<string>
}>()

export const logsDir = () => join(
  pnyxHome(),
  'logs',
)

// One file per UTC day, named by its date.
export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

const dayFile = ({ day }: { day: string }) => `${day}.jsonl`

// Held in memory and changed with the setting, so a line never reads settings.
let mode: LogMode = 'on'
// Only the server writes the log folder; any other process keeps warnings and errors on its stderr.
let toFiles = false
let file: {
  day: string
  path: string
} | undefined
// Full days keep warnings and errors, while action lines stop at the size cap.
let capped: string | undefined
let byteLimit = Infinity
const dayBytes = new Map<string, number>()
let dropped = 0
const FAILURE_ROOM = 2

export const setLogMode = ({ mode: next }: { mode: LogMode }) => {
  mode = next
}

export const logMode = () => mode

export function setLogBudget({
  maxBytes,
  days,
}: {
  maxBytes?: number
  days?: {
    day: string
    bytes: number
  }[]
}): void {
  if (maxBytes !== undefined) {
    byteLimit = maxBytes
  }

  if (days !== undefined) {
    const retained = new Map(days.map(day => [
      day.day,
      Math.max(
        day.bytes,
        dayBytes.get(day.day) ?? 0,
      ),
    ]))

    if (file && !retained.has(file.day)) {
      retained.set(
        file.day,
        dayBytes.get(file.day) ?? 0,
      )
    }

    dayBytes.clear()

    for (const [
      day,
      bytes,
    ] of retained) {
      dayBytes.set(
        day,
        bytes,
      )
    }
  }

  if (dropped) {
    const count = dropped
    dropped = 0
    // stderr remains available even when the JSONL budget is exhausted.
    console.error(JSON.stringify({
      v: 1,
      at: new Date().toISOString(),
      level: 'warn',
      source: 'server',
      pid: process.pid,
      operation: 'logs.dropped',
      operationId: randomUUID(),
      count,
    }))
  }
}

export function openLogs(): void {
  toFiles = true
}

// The next line opens its day's file again, after cleanup deleted the current one.
export function releaseLogFile(): void {
  if (file) {
    streams.get(file.path)?.stream.end()
    streams.delete(file.path)
    file = undefined
  }
}

export function closeLogs(): void {
  flushRepeatedLines()
  releaseLogFile()
  toFiles = false
}

function append({
  text,
  day,
  severe,
}: {
  text: string
  day: string
  severe: boolean
}): void {
  if (!toFiles) {
    if (severe) {
      console.error(text)
    }

    return
  }

  try {
    if (file?.day !== day) {
      releaseLogFile()
      privateDir({ dir: logsDir() })
      file = {
        day,
        path: join(
          logsDir(),
          dayFile({ day }),
        ),
      }

      let bytes = dayBytes.get(day) ?? 0

      try {
        bytes = Math.max(
          bytes,
          statSync(file.path).size,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      dayBytes.set(
        day,
        bytes,
      )
    }

    const currentBytes = dayBytes.get(day) ?? 0
    const path = file.path
    const olderBytes = [...dayBytes].reduce(
      (
        sum,
        [
          otherDay,
          bytes,
        ],
      ) => otherDay === day ? sum : sum + bytes,
      0,
    )
    const allowance = Math.max(
      0,
      byteLimit - olderBytes,
    )

    const bytes = Buffer.byteLength(text) + 1
    const limit = severe ? allowance * FAILURE_ROOM : allowance

    if (currentBytes + bytes > limit) {
      dropped += 1

      if (!severe && capped !== day) {
        capped = day
        log({
          level: 'warn',
          operation: 'logs.full',
          bytes: allowance,
        })
      }

      return
    }

    dayBytes.set(
      day,
      currentBytes + bytes,
    )
    let output = streams.get(path)

    if (!output) {
      const stream = createWriteStream(
        path,
        {
          flags: 'a',
          mode: 0o600,
        },
      )
      output = {
        stream,
        lines: new Set(),
      }
      streams.set(
        path,
        output,
      )
      stream.on(
        'error',
        error => console.error(String(error)),
      )
    }

    const line = `${text}\n`
    const lines = output.lines
    lines.add(line)
    output.stream.write(
      line,
      () => lines.delete(line),
    )
  } catch (error) {
    // An unwritable log folder must not break the action being logged: a warning or error goes to stderr instead, with the write error.
    releaseLogFile()

    if (severe) {
      console.error(text)
      console.error(String(error))
    }
  }
}

// Graceful shutdown and diagnostics readers can finish outstanding appends without delaying ordinary log calls.
export async function flushLogs(): Promise<void> {
  const outputs = [...streams.values()]
  streams.clear()
  await Promise.all(outputs.map(({ stream }) => new Promise<void>((
    resolve,
    reject,
  ) => {
    stream.once(
      'error',
      reject,
    )
    stream.end(resolve)
  })))
}

// Node cannot drain a stream after exit starts. Preserve queued diagnostics on fatal exits.
export function flushLogsSync(): void {
  for (const [
    path,
    {
      stream,
      lines,
    },
  ] of streams) {
    stream.destroy()

    try {
      appendFileSync(
        path,
        [...lines].join(''),
        { mode: 0o600 },
      )
    } catch (error) {
      console.error(String(error))
    }
  }

  streams.clear()
}

process.on(
  'exit',
  flushLogsSync,
)

export function writeLine({
  line,
  source,
  at = new Date().toISOString(),
  repeated = false,
}: {
  line: LogLine
  repeated?: boolean
  source: 'server' | 'web'
  // When it happened, if not now: a page's lines arrive in batches.
  at?: string
}): void {
  const {
    operation,
    operationId,
    level,
    error,
    detailed,
    ms,
  } = line
  // A failure always has an id, so a retry can share it and the timeline can page by it.
  const failureId = level && !operationId ? randomUUID() : operationId
  const fields: Record<string, unknown> = {}
  let text: string

  for (const key of Object.keys(line)) {
    const value = line[key as keyof LogLine]

    if (LOG_FIELDS.has(key)) {
      fields[key] = typeof value === 'string' ? value.slice(
        0,
        TEXT_MAX,
      ) : value
    }
  }

  // A line that cannot be built must not break the action it describes; a failure still reaches stderr.
  try {
    text = JSON.stringify({
      v: 1,
      at,
      level: level ?? (detailed ? 'debug' : 'info'),
      startedAt: ms === undefined ? undefined : new Date(Date.parse(at) - ms).toISOString(),
      source,
      pid: source === 'server' ? process.pid : undefined,
      requestId: source === 'server' ? logRequestId() : undefined,
      operation,
      operationId: failureId,
      ...fields,
      ms: ms === undefined ? undefined : oneDecimal({ value: ms }),
      // Detailed lines come many a second, so the lines around them carry the server's memory.
      rss: source === 'server' && !detailed ? process.memoryUsage.rss() : undefined,
      // An error line describes its error even when what was thrown is undefined.
      error: level === 'error' || (level && error !== undefined) ? logFailure({ error }) : undefined,
    })
  } catch (unbuilt) {
    if (level) {
      console.error(`${operation}: ${String(unbuilt)}`)
    }

    return
  }

  if (!repeated && repeatedLine({
    line,
    write: ({ line }) => writeLine({
      line,
      source,
      repeated: true,
    }),
  })) {
    return
  }

  append({
    day: logDay({ at }),
    severe: level !== undefined,
    text,
  })
}

// Writes the line when the level allows it: a detailed line only under Detailed, a warning or error always.
// eslint-disable-next-line pnyx/object-params -- the line passes on whole, so nothing is copied before the level check.
export function log(line: LogLine): void {
  // Outside the server only warnings and errors are printed, so other lines stop before they are built.
  const printed = toFiles || line.level !== undefined

  if (!printed || !logged({
    mode,
    line,
  })) {
    return
  }

  writeLine({
    line,
    source: 'server',
  })
}
