import type { HydraState } from '#app/model.ts'

export function stored<Value>({
  key,
  fallback,
}: {
  key: string
  fallback: Value
}): Value {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}

export function save({
  key,
  value,
}: {
  key: string
  value: unknown
}) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(value),
    )
  } catch { /* The open tab retains its pending work when storage is full or blocked. */ }
}

export function removeStored({ key }: { key: string }) {
  try {
    sessionStorage.removeItem(key)
  } catch { /* Storage may be blocked. */ }
}

export function confirmedState({ state }: { state: HydraState }): HydraState {
  const cards = Object.fromEntries(Object.entries(state.cards).map(([
    id,
    original,
  ]) => {
    const card = { ...original }
    delete card.spend
    delete card.usage

    return [
      id,
      card,
    ]
  }))

  return {
    ...state,
    cards,
  }
}
