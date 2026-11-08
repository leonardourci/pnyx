export const ESTIMATED_TOKEN_BYTES = 4

export function countTokens({ text }: { text: string }): number {
  return Math.ceil(new TextEncoder().encode(text).length / ESTIMATED_TOKEN_BYTES)
}
