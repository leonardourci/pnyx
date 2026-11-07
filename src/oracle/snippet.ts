import type { SnippetPart } from './model.ts'

// Private-use characters, which ordinary text never holds.
export const MATCH_START = '\uE000'
export const MATCH_END = '\uE001'

// A marked text's parts, each flagged when it lies between a start and an end mark.
export function markedParts({ text }: { text: string }): SnippetPart[] {
  const parts: SnippetPart[] = []
  let matched = false

  for (const part of text.split(new RegExp(`([${MATCH_START}${MATCH_END}])`))) {
    if (part === MATCH_START) {
      matched = true
    } else if (part === MATCH_END) {
      matched = false
    } else if (part) {
      parts.push({
        text: part,
        matched,
      })
    }
  }

  return parts
}
