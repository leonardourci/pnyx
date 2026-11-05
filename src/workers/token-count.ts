const ESTIMATED_BYTES_PER_TOKEN = 4

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
  const validReported = reported !== undefined && Number.isFinite(reported)
    && Number.isInteger(reported) && reported >= 0

  if (validReported) {
    return {
      tokens: reported,
      source: 'reported',
    }
  }

  return {
    tokens: Math.ceil(new TextEncoder().encode(text).length / ESTIMATED_BYTES_PER_TOKEN),
    source: 'estimated',
  }
}
