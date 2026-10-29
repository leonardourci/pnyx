export const INPUT = 'input'

export type FocusMove = 'next' | 'previous' | 'escape'

// Focus outside the cycle counts as the input, so a stray focus always rejoins it.
export function moveFocus<T>({
  controls,
  from,
  move,
}: {
  controls: T[]
  from: T | typeof INPUT
  move: FocusMove
}): T | typeof INPUT {
  if (move === 'escape') {
    return INPUT
  }

  const order: (T | typeof INPUT)[] = [
    INPUT,
    ...controls,
  ]
  const at = Math.max(
    0,
    order.indexOf(from),
  )
  const step = move === 'next' ? 1 : -1

  return order[(at + step + order.length) % order.length]!
}

export function recoverFocus<T>({
  before,
  controls,
  lost,
}: {
  // The controls when the lost one last had focus.
  before: T[]
  controls: T[]
  lost: T
}): T | typeof INPUT {
  const after = before.slice(before.indexOf(lost) + 1)

  return after.find(control => controls.includes(control)) ?? INPUT
}
