import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { pnyxHome } from '#store/paths.ts'
import { privateDir } from '#store/storage.ts'
import { LOG_FIELDS, logDay, logged, oneDecimal, TEXT_MAX, type LogLine, type LogMode } from './log-line.ts'

export type { LogLine, LogMode } from './log-line.ts'

const FAILURE_INSPECT_DEPTH = 2
const FAILURE_INSPECT_CHARS = 2000

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
  fd: number
} | undefined
// The day whose file the last cleanup found past the size cap: until it ends that file takes only warnings and
// errors, and once overfull nothing more, counting the warnings and errors it drops.
let capped: {
  day: string
  overfull: boolean
} | undefined
let dropped = 0

export const setLogMode = ({ mode: next }: { mode: LogMode }) => {
  mode = next
}

export const logMode = () => mode

// Set by each cleanup. The first time today's file passes the cap, a warning says why the action lines stop; while
// it is overfull, each cleanup writes how many warnings and errors it dropped since the last one.
export function setTodayFull({
  day,
  full,
  overfull,
  maxBytes,
}: {
  day: string
  full: boolean
  overfull: boolean
  maxBytes?: number
}): void {
  const filled = full && capped?.day !== day
  const count = dropped
  // Cleared first, so these two warnings reach the file however full it is.
  capped = undefined
  dropped = 0

  if (filled) {
    log({
      level: 'warn',
      operation: 'logs.full',
      bytes: maxBytes,
    })
  }

  if (count) {
    log({
      level: 'warn',
      operation: 'logs.dropped',
      count,
    })
  }

  capped = full ? {
    day,
    overfull,
  } : undefined
}

export function openLogs(): void {
  toFiles = true
}

// The next line opens its day's file again, after cleanup deleted the current one.
export function releaseLogFile(): void {
  if (file) {
    closeSync(file.fd)
    file = undefined
  }
}

export function closeLogs(): void {
  releaseLogFile()
  toFiles = false
}

function failure({ error }: { error: unknown }) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
      stack: error.stack,
    }
  }

  return {
    message: typeof error === 'string' ? error : inspect(
      error,
      {
        customInspect: false,
        depth: FAILURE_INSPECT_DEPTH,
        maxStringLength: FAILURE_INSPECT_CHARS,
      },
    ).slice(
      0,
      FAILURE_INSPECT_CHARS,
    ),
  }
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

  if (capped?.day === day && (capped.overfull || !severe)) {
    // Action lines stop at the cap by design; only the warnings and errors an overfull day drops are counted.
    if (severe) {
      dropped += 1
    }

    return
  }

  try {
    if (file?.day !== day) {
      releaseLogFile()
      privateDir({ dir: logsDir() })
      file = {
        day,
        fd: openSync(
          join(
            logsDir(),
            dayFile({ day }),
          ),
          'a',
          0o600,
        ),
      }
    }

    // ponytail: one synchronous append per line; queue writes if lines ever reach thousands a second.
    writeSync(
      file.fd,
      `${text}\n`,
    )
  } catch (error) {
    // An unwritable log folder must not break the action being logged: a warning or error goes to stderr instead, with the write error.
    dropLogFile()

    if (severe) {
      console.error(text)
      console.error(String(error))
    }
  }
}

// After a failed write the descriptor may be unusable, so closing it can fail as well; the write error is the one reported.
function dropLogFile(): void {
  const failed = file
  file = undefined

  try {
    if (failed) {
      closeSync(failed.fd)
    }
  } catch { /* reported as the write error */ }
}

export function writeLine({
  line,
  source,
  at = new Date().toISOString(),
}: {
  line: LogLine
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
      level,
      source,
      pid: source === 'server' ? process.pid : undefined,
      operation,
      operationId: failureId,
      ...fields,
      detailed: detailed ? true : undefined,
      ms: ms === undefined ? undefined : oneDecimal({ value: ms }),
      rss: source === 'server' ? process.memoryUsage.rss() : undefined,
      // An error line describes its error even when what was thrown is undefined.
      error: level === 'error' || (level && error !== undefined) ? failure({ error }) : undefined,
    })
  } catch (unbuilt) {
    if (level) {
      console.error(`${operation}: ${String(unbuilt)}`)
    }

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
