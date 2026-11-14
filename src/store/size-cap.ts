// The most one item the server holds or sends may weigh, as Paseo caps each timeline item.
export const MAX_ITEM_BYTES = 64 * 1024

// Strings longer than the first limit are cut; the next limit applies only if the item is still over.
const STRING_LIMITS = [
  16_384,
  4096,
  1024,
  256,
]

const jsonBytes = ({ value }: { value: unknown }) => Buffer.byteLength(JSON.stringify(value) ?? '')

const cutStrings = ({
  value,
  limit,
}: {
  value: unknown
  limit: number
}): unknown => {
  if (typeof value === 'string') {
    return value.length > limit
      ? `${value.slice(
        0,
        limit,
      )}… (${value.length - limit} more characters cut)`
      : value
  }

  if (Array.isArray(value)) {
    return value.map(item => cutStrings({
      value: item,
      limit,
    }))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([
      key,
      item,
    ]) => [
      key,
      cutStrings({
        value: item,
        limit,
      }),
    ]))
  }

  return value
}

// The item itself while it fits; otherwise a copy whose long strings are cut until it does.
export function capItem<T>({
  value,
  bytes = MAX_ITEM_BYTES,
}: {
  value: T
  bytes?: number
}): T {
  if (jsonBytes({ value }) <= bytes) {
    return value
  }

  let cut = value

  for (const limit of STRING_LIMITS) {
    cut = cutStrings({
      value,
      limit,
    }) as T

    if (jsonBytes({ value: cut }) <= bytes) {
      break
    }
  }

  return cut
}
