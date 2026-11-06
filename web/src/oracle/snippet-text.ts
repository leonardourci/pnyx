import type { Snippet } from '#oracle/model.ts'
import { markdownText } from '#web-hydra/markdown-text.ts'

const MATCH_START = '\uE000'
const MATCH_END = '\uE001'

export function snippetText({ snippet }: { snippet: Snippet }): NonNullable<Snippet['parts']> {
  const text = snippet.parts
    ? snippet.parts.map(part => part.matched ? `${MATCH_START}${part.text}${MATCH_END}` : part.text).join('')
    : snippet.snippet
  const plain = markdownText({ text })
  const parts: NonNullable<Snippet['parts']> = []
  let matched = false

  for (const part of plain.split(/([\uE000\uE001])/)) {
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
