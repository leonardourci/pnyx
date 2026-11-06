export function countTokens({ text }: { text: string }): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4)
}
