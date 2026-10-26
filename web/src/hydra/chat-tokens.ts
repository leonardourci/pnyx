import type { Suggestion } from '../../../src/thread/catalog.ts'

export function knownCommands({
  text,
  suggestions,
  leading = true,
  codexOnly = false,
}: {
  text: string
  suggestions: Suggestion[]
  leading?: boolean
  codexOnly?: boolean
}) {
  const matches = [
    ...text.matchAll(/\$[a-zA-Z0-9_:-]+/g),
    ...codexOnly ? [] : [...text.matchAll(/(?<!\S)\/[a-zA-Z0-9_.:-]+(?=$|\s)/g)],
  ].sort((
    a,
    b,
  ) => a.index - b.index)

  return matches
    .flatMap(match => {
      const candidates = suggestions.filter(item => item.command === match[0] && !item.file)
      const item = candidates.length === 1 ? candidates[0] : undefined
      const startOnly = item?.source === 'Agent commands' || item?.command.startsWith('/prompts:')

      if (startOnly && (!leading || text.slice(
        0,
        match.index,
      ).trim())) {
        return []
      }

      return item ? [
        {
          start: match.index,
          end: match.index + match[0].length,
          item,
        },
      ] : []
    })
}
