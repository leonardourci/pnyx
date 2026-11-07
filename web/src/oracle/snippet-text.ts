import type { Snippet, SnippetPart } from '#oracle/model.ts'
import { MATCH_END, MATCH_START, markedParts } from '#oracle/snippet.ts'
import { markdownText } from '#web-hydra/markdown-text.ts'

// The marks go back into the text so Markdown stripping keeps the server's match boundaries.
export function snippetText({ snippet }: { snippet: Snippet }): SnippetPart[] {
  const text = snippet.parts
    ? snippet.parts.map(part => part.matched ? `${MATCH_START}${part.text}${MATCH_END}` : part.text).join('')
    : snippet.snippet

  return markedParts({ text: markdownText({ text }) })
}
