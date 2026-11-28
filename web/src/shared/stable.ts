import { useRef, useState } from 'react'

// eslint-disable-next-line othrys/object-params -- a type for any callback; each one takes its own object.
type Action = (input: never) => unknown

// Callbacks that keep their identity across renders and always call the latest ones, so a memoized child that
// receives them redraws only when its own data changes.
export function useStableActions<Actions extends Record<string, Action>>({
  actions,
}: { actions: Actions }): Actions {
  const latest = useRef(actions)
  latest.current = actions
  const [stable] = useState(() => Object.fromEntries(Object.keys(actions).map(key => [
    key,
    // eslint-disable-next-line othrys/object-params -- forwards whatever object the callback takes.
    (input: never) => latest.current[key]!(input),
  ])) as Actions)

  return stable
}

// The previous value while the next one reads the same, so whatever receives it is not redrawn for a copy.
export function kept<Value>({
  previous,
  next,
}: {
  previous: Value
  next: Value
}): Value {
  const same = previous === next || JSON.stringify(previous) === JSON.stringify(next)

  return same ? previous : next
}

export function useKept<Value>({ value }: { value: Value }): Value {
  const held = useRef(value)
  held.current = kept({
    previous: held.current,
    next: value,
  })

  return held.current
}

const plain = ({ value }: { value: unknown }) => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === Array.prototype
}

// The next value with each branch that reads the same swapped for the previous one, so a rebuilt view keeps its identity.
export function shared<Value>({
  previous,
  next,
}: {
  previous?: Value
  next: Value
}): Value {
  const comparable = plain({ value: previous }) && plain({ value: next })
    && Array.isArray(previous) === Array.isArray(next)

  if (previous === next || !comparable) {
    return next
  }

  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  const result = (Array.isArray(next) ? [] : {}) as Record<string, unknown>

  for (const key of keys) {
    result[key] = shared({
      previous: before[key],
      next: after[key],
    })
  }

  const sameKeys = keys.length === Object.keys(before).length
  const same = sameKeys && keys.every(key => result[key] === before[key])

  return same ? previous as Value : result as Value
}
