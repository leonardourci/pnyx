const normalized = ({ text }: { text: string }) => text.toLowerCase().replace(
  /[^\p{L}\p{N}]/gu,
  '',
)

function suggestionRank({
  name,
  query,
}: {
  name: string
  query: string
}): number | undefined {
  const search = normalized({ text: query })
  const compact = normalized({ text: name })

  if (compact.startsWith(search)) {
    return 0
  }

  if (!compact.includes(search)) {
    return undefined
  }

  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  const atWordStart = words.some((
    _,
    index,
  ) => words.slice(index).join('')
    .startsWith(search))

  return atWordStart ? 1 : 2
}

export function matchingSuggestions<T>({
  items,
  query,
  name,
  fallback,
}: {
  items: T[]
  query: string
  name: ({ item }: { item: T }) => string
  fallback?: ({ item }: { item: T }) => string
}): T[] {
  return items.flatMap(item => {
    const rank = suggestionRank({
      name: name({ item }),
      query,
    })

    if (rank !== undefined) {
      return [
        {
          item,
          rank,
        },
      ]
    }

    if (fallback && suggestionRank({
      name: fallback({ item }),
      query,
    }) !== undefined) {
      return [
        {
          item,
          rank: 3,
        },
      ]
    }

    return []
  }).sort((
    a,
    b,
  ) => a.rank - b.rank)
    .map(({ item }) => item)
}
