import { useRef, useState } from 'react'

// eslint-disable-next-line pnyx/object-params -- a type for any callback; each one takes its own object.
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
    // eslint-disable-next-line pnyx/object-params -- forwards whatever object the callback takes.
    (input: never) => latest.current[key]!(input),
  ])) as Actions)

  return stable
}

// The previous value while the new one reads the same, so a child receiving it is not redrawn for a copy.
export function useKept<Value>({ value }: { value: Value }): Value {
  const kept = useRef(value)
  const same = kept.current === value || JSON.stringify(kept.current) === JSON.stringify(value)

  if (!same) {
    kept.current = value
  }

  return kept.current
}
