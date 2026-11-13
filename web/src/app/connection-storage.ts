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
