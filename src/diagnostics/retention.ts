import { logDay } from '#app/log-line.ts'

const DAY_MS = 24 * 60 * 60 * 1000
// Warnings and errors may take today's file to this many times the cap; past it they are dropped and counted.
const FAILURE_ROOM = 2

// Which day files a cleanup keeps: the last `keepDays` days, today included, then from the newest back only while
// the total fits in `maxBytes`. Today's file is the one being written, so it stays even when it alone passes the cap;
// `full` then says only warnings and errors should still go in it, and `overfull` that nothing more should.
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
    full: todayBytes > maxBytes,
    overfull: todayBytes > FAILURE_ROOM * maxBytes,
  }
}
