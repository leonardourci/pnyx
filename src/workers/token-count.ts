export function countTokens({
  text,
  reported,
}: {
  text: string
  reported?: number
}): {
  tokens: number
  source: 'reported' | 'estimated'
} {
  if (reported !== undefined && Number.isFinite(reported) && Number.isInteger(reported)
    && reported >= 0) {
    return {
      tokens: reported,
      source: 'reported',
    }
  }

  return {
    tokens: Math.ceil(new TextEncoder().encode(text).length / 4),
    source: 'estimated',
  }
}
