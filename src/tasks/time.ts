import { HydraError } from '#store/errors.ts'

// RegExp captures are strings, though both parsers only accept these unit keys.
type IntervalUnit = 'minute' | 'hour' | 'day'

const INTERVAL_UNITS: Record<IntervalUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

export function reminderIntervalText({ milliseconds }: { milliseconds: number }): string {
  for (const [
    unit,
    size,
  ] of Object.entries(INTERVAL_UNITS).reverse()) {
    if (milliseconds % size === 0) {
      const count = milliseconds / size

      return `${count} ${unit}${count === 1 ? '' : 's'}`
    }
  }

  return `${milliseconds / INTERVAL_UNITS.minute} minutes`
}

export function reminderInterval({ text }: { text: string }): number {
  const match = /^([1-9]\d*) (minute|hour|day)s?$/i.exec(text.trim())
  const unit = match?.[2]?.toLowerCase() as IntervalUnit | undefined
  const milliseconds = match && unit ? Number(match[1]) * INTERVAL_UNITS[unit] : NaN

  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Choose a positive interval such as "30 minutes", "4 hours" or "1 day"',
    })
  }

  return milliseconds
}

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
    const unit = relative[2]!.toLowerCase() as IntervalUnit
    time = Date.parse(now) + Number(relative[1]) * INTERVAL_UNITS[unit]
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
