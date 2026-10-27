import { HOUR_MS } from '../../../src/core/retention.ts'

export function elapsedTime({
  at,
  now,
}: {
  at: string
  now: number
}): string {
  const elapsed = Math.max(
    0,
    now - Date.parse(at),
  )

  return elapsed < 60_000 ? 'just now' : elapsed < HOUR_MS ? `${Math.floor(elapsed / 60_000)}m ago`
    : elapsed < 24 * HOUR_MS ? `${Math.floor(elapsed / HOUR_MS)}h ago` : `${Math.floor(elapsed / (24 * HOUR_MS))}d ago`
}
