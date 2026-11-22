// Reducers can pass draft proxies, so copy their JSON fields without structuredClone.
export function cloneValue<T>({ value }: { value: T }): T {
  if (Array.isArray(value)) {
    return value.map(child => cloneValue({ value: child })) as T
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([
      key,
      child,
    ]) => [
      key,
      cloneValue({ value: child }),
    ])) as T
  }

  return value
}
