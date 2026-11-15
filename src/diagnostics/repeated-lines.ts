import type { LogLine } from '#app/log-line.ts'
import { logFailure } from './log-failure.ts'

const REPEAT_INTERVAL_MS = 60_000
const MAX_REPEAT_KEYS = 1000
const repeats = new Map<string, {
  line: LogLine
  count: number
  timer: NodeJS.Timeout
  write({ line }: { line: LogLine }): void
}>()

// First occurrences stay immediate. A bounded window reports the suppressed count even if no next line arrives.
export function repeatedLine({
  line,
  write,
}: {
  line: LogLine
  write({ line }: { line: LogLine }): void
}): boolean {
  if (!line.level) {
    return false
  }

  const key = JSON.stringify([
    line.operation,
    line.name,
    line.level,
    line.hydraId,
    line.taskId,
    line.sessionId,
    line.code,
    line.count,
    line.status,
    line.exitCode,
    line.provider,
    logFailure({ error: line.error }),
  ])
  const existing = repeats.get(key)

  if (existing) {
    existing.count += 1

    return true
  }

  if (repeats.size >= MAX_REPEAT_KEYS) {
    return false
  }

  const entry = {
    line,
    count: 0,
    write,
    timer: setTimeout(
      () => {
        repeats.delete(key)

        if (entry.count) {
          write({
            line: {
              ...entry.line,
              repeatCount: entry.count,
            },
          })
        }
      },
      REPEAT_INTERVAL_MS,
    ).unref(),
  }
  repeats.set(
    key,
    entry,
  )

  return false
}

export function flushRepeatedLines(): void {
  for (const entry of repeats.values()) {
    clearTimeout(entry.timer)

    if (entry.count) {
      entry.write({
        line: {
          ...entry.line,
          repeatCount: entry.count,
        },
      })
    }
  }

  repeats.clear()
}
