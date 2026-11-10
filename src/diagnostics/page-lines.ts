import { asRecord } from '#app/command-validation.ts'
import { log, logMode, writeLine, type LogLine } from '#app/diagnostics.ts'
import { logged, PAGE_LINES_MAX, STACK_MAX, TEXT_MAX } from '#app/log-line.ts'
import { HYDRA_ID } from '#hydra/identity.ts'

const PAGE_OPERATION = /^page\.[a-z][a-z-]{0,40}$/
// A page's own time is kept when its clock agrees with the server's; a line is at most a few seconds old.
const PAGE_CLOCK_SKEW_MS = 5 * 60_000
const PAGE_TEXT_FIELDS = [
  'taskId',
  'sessionId',
  'name',
  'status',
  'code',
  'tab',
  'script',
] as const
const PAGE_NUMBER_FIELDS = [
  'ms',
  'bytes',
  'count',
  'blockingMs',
] as const

const text = ({
  value,
  max = TEXT_MAX,
}: {
  value: unknown
  max?: number
}) => typeof value === 'string' && value.length <= max ? value : undefined

const finite = ({ value }: { value: unknown }) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

// The page's error arrives as plain text; it is rebuilt so the logger records it like a server error.
function pageError({ value }: { value: unknown }): Error {
  const record = asRecord({ value })
  const error = new Error(text({ value: record?.message }) ?? 'unknown page error')
  error.name = text({ value: record?.name }) ?? 'Error'
  error.stack = text({
    value: record?.stack,
    max: STACK_MAX,
  })

  return error
}

// When the page saw it, if its clock agrees with the server's.
function pageTime({ value }: { value: unknown }): string | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN

  const agrees = Number.isFinite(at) && Math.abs(at - Date.now()) <= PAGE_CLOCK_SKEW_MS

  return agrees ? new Date(at).toISOString() : undefined
}

function pageLine({ value }: { value: unknown }): LogLine | undefined {
  const record = asRecord({ value })
  const operation = text({ value: record?.operation })
  const hydraId = text({ value: record?.hydraId })

  const knownHydra = hydraId === undefined || HYDRA_ID.test(hydraId)

  if (!record || !operation || !PAGE_OPERATION.test(operation) || !knownHydra) {
    return undefined
  }

  const fields: Omit<LogLine, 'operation' | 'level' | 'error' | 'detailed'> = { hydraId }

  for (const key of PAGE_TEXT_FIELDS) {
    fields[key] = text({ value: record[key] })
  }

  for (const key of PAGE_NUMBER_FIELDS) {
    fields[key] = finite({ value: record[key] })
  }

  if (record.level === 'error' || record.level === 'warn') {
    return {
      ...fields,
      operation,
      level: record.level,
      error: pageError({ value: record.error }),
    }
  }

  return {
    ...fields,
    operation,
    detailed: record.detailed === true,
  }
}

// Writes the lines a page batched, marked as the page's; lines that do not fit a page line are counted once.
export function logPageLines({ value }: { value: unknown }): void {
  const lines = Array.isArray(value) ? value.slice(
    0,
    PAGE_LINES_MAX,
  ) : []
  let refused = Array.isArray(value) ? Math.max(
    0,
    value.length - PAGE_LINES_MAX,
  ) : 1

  for (const item of lines) {
    const line = pageLine({ value: item })

    if (!line) {
      refused += 1
    } else if (logged({
      mode: logMode(),
      line,
    })) {
      writeLine({
        line,
        source: 'web',
        at: pageTime({ value: asRecord({ value: item })?.at }),
      })
    }
  }

  if (refused) {
    log({
      level: 'warn',
      operation: 'page.lines-refused',
      count: refused,
    })
  }
}
