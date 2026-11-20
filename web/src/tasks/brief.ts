export function relativeTime({
  at,
  now,
  compact = false,
}: {
  at: string | undefined
  now: number
  compact?: boolean
}): string {
  const value = at ? Date.parse(at) : NaN

  if (!Number.isFinite(value)) {
    return 'Time not recorded'
  }

  const seconds = Math.max(
    0,
    (now - value) / 1000,
  )

  for (const [
    unit,
    size,
  ] of [
      [
        'y',
        31536000,
      ],
      [
        'mo',
        2592000,
      ],
      [
        'd',
        86400,
      ],
      [
        'h',
        3600,
      ],
      [
        'm',
        60,
      ],
    ] as const) {
    if (seconds >= size) {
      const elapsed = `${Math.floor(seconds / size)}${unit}`

      return compact ? elapsed : `${elapsed} ago`
    }
  }

  return compact ? 'now' : 'just now'
}
