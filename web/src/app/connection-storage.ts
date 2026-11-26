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

export function dropSnapshots() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('othrys:') && key.endsWith(':hydra-state')) {
        sessionStorage.removeItem(key)
      }
    }
  } catch { /* Blocked storage holds nothing this page could remove. */ }
}
