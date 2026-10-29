// The palette's input; every other stop is one of the preview's controls.
export const INPUT = 'input'

export type FocusMove = 'next' | 'previous' | 'escape'

// The palette's one Tab order: the input, then the preview's controls in document order, then the input again.
// Focus anywhere else counts as the input, so a stray focus always rejoins the cycle.
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

// Where focus goes once its control unmounted or was disabled: the next control after it that is still there, else the input.
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
