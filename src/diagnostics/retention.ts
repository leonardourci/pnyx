import { logDay } from '#app/log-line.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// Keep today's file, then the newest days that fit in the folder budget.
export function keptDays({
  days,
  keepDays,
  maxBytes,
  today,
}: {
  days: {
    day: string
    bytes: number
  }[]
  keepDays: number
  maxBytes: number
  today: string
}) {
  const oldestKept = logDay({ at: new Date(Date.parse(`${today}T00:00:00.000Z`) - (keepDays - 1) * DAY_MS).toISOString() })
  const todayBytes = days.find(file => file.day === today)?.bytes ?? 0
  // A day dated after today, from a clock that moved back, is the newest but never pushes today out.
  const newestFirst = days.filter(file => file.day >= oldestKept && file.day !== today).toSorted((
    a,
    b,
  ) => b.day.localeCompare(a.day))
  const kept = new Set<string>([today])
  let total = todayBytes

  for (const file of newestFirst) {
    if (total + file.bytes > maxBytes) {
      break
    }

    kept.add(file.day)
    total += file.bytes
  }

  return {
    kept,
  }
}
