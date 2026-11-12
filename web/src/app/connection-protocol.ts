import type { HydraState } from '#app/model.ts'
import { sessionId } from '#workers/session-attachments.ts'

export { commandTimeout, retryable } from '#app/server-protocol.ts'

export const reconnectDelay = ({ attempt }: { attempt: number }) =>
  Math.min(
    500 * 2 ** Math.min(
      attempt,
      5,
    ),
    10000,
  )

export function retainedReadings<Value>({
  current,
  before,
  after,
}: {
  current: Record<string, Value>
  before: HydraState
  after: HydraState
}): Record<string, Value> {
  const entries = Object.entries(current)
  const retained = entries.filter(([id]) => {
    const previous = before.cards[id]?.agent
    const next = after.cards[id]?.agent

    return previous !== undefined && next !== undefined
      && sessionId({ agent: previous }) === sessionId({ agent: next })
  })

  return retained.length === entries.length ? current : Object.fromEntries(retained)
}

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
