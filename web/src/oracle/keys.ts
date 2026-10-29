export const HIT_ROW = 'hit:'

export type InputKey = 'clear' | 'first' | 'last' | 'open' | 'wait'
export const WAITING_KEYS = [
  'Enter',
  'ArrowDown',
  'ArrowUp',
]

// Enter and the arrows wait for a pending answer, so they never act on rows about to be replaced.
export function inputKey({
  key,
  composing,
  pending,
  first,
}: {
  key: string
  composing: boolean
  pending: boolean
  first?: string
}): InputKey | null {
  if (composing) {
    return null
  }

  if (key === 'Escape') {
    return 'clear'
  }

  if (pending && WAITING_KEYS.includes(key)) {
    return 'wait'
  }

  if (key === 'ArrowDown') {
    return 'first'
  }

  if (key === 'ArrowUp') {
    return 'last'
  }

  if (key !== 'Enter') {
    return null
  }

  return first?.startsWith(HIT_ROW) ? 'open' : 'first'
}
