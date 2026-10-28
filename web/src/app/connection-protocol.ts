import { CLONE_TIMEOUT_MS } from '#projects/limits.ts'

export const reconnectDelay = ({ attempt }: { attempt: number }) =>
  Math.min(
    500 * 2 ** Math.min(
      attempt,
      5,
    ),
    10000,
  )
export const retryable = ({
  name,
  args,
}: {
  name: string
  args: string[]
}) =>
  [
    'reply',
    'task-message',
    'answer',
    'agent',
    'hydra-agent',
  ].includes(name) || (name === 'hydra' && args[0] === 'send' && args.includes('--event-id'))

export function commandTimeout({
  name,
  args,
}: {
  name: string
  args: string[]
}): number {
  if (name === 'project' && args[0] === 'add' && args.includes('--clone')) {
    return CLONE_TIMEOUT_MS + 20_000
  }

  return [
    'reply',
    'task-message',
    'answer',
    'agent',
  ].includes(name) ? 140000 : 60000
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
