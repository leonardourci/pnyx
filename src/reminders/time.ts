import { HydraError } from '../store/errors.ts'

export function reminderTime({
  when,
  now,
}: {
  when: string
  now: string
}): string {
  const text = when.trim()
  let time = NaN
  const relative = /^in ([1-9]\d*) (minute|hour|day)s?$/i.exec(text)
  const tomorrow = /^tomorrow(?: (?:at )?([01]?\d|2[0-3]):([0-5]\d))?$/i.exec(text)

  if (relative) {
    const unit = relative[2]!.toLowerCase()
    time = Date.parse(now) + Number(relative[1]) * (unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000)
  } else if (tomorrow) {
    const date = new Date(now)
    date.setDate(date.getDate() + 1)
    date.setHours(
      Number(tomorrow[1] ?? 9),
      Number(tomorrow[2] ?? 0),
      0,
      0,
    )
    time = date.getTime()
  } else if (/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const date = text.slice(
      0,
      text.search(/t/i),
    )
    const calendar = new Date(`${date}T00:00:00Z`)

    if (Number.isFinite(calendar.getTime()) && calendar.toISOString().startsWith(date)) {
      time = Date.parse(text)
    }
  }

  if (!Number.isFinite(time) || time <= Date.parse(now) || time > 8_640_000_000_000_000) {
    throw new HydraError({
      message: 'Choose a future reminder time',
      code: 'VALIDATION_ERROR',
      help: ['Use an ISO timestamp with a timezone, "tomorrow 9:00" (laptop time), or "in 2 hours"; use clear to remove a reminder'],
    })
  }

  return new Date(time).toISOString()
}
