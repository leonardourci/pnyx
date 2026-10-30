export { commandTimeout, retryable } from '#app/server-protocol.ts'

export const reconnectDelay = ({ attempt }: { attempt: number }) =>
  Math.min(
    500 * 2 ** Math.min(
      attempt,
      5,
    ),
    10000,
  )

// A push carries only the cards that changed; null drops a card's value.
export function withChanges<Value>({
  current,
  changes,
}: {
  current: Record<string, Value>
  changes: Record<string, Value | null>
}): Record<string, Value> {
  const next = { ...current }

  for (const [
    card,
    value,
  ] of Object.entries(changes)) {
    if (value) {
      next[card] = value
    } else {
      delete next[card]
    }
  }

  return next
}
