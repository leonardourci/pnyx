import type { Suggestion } from '#hydra/transcripts-catalog.ts'
import { isUpgradeSuggestion } from '#upgrade/model.ts'

export function knownCommands({
  text,
  suggestions,
}: {
  text: string
  suggestions: Suggestion[]
}) {
  const matches = [
    ...text.matchAll(/\$[a-zA-Z0-9_:-]+/g),
    ...text.matchAll(/(?<!\S)\/[a-zA-Z0-9_.:-]+(?=$|\s)/g),
  ].sort((
    a,
    b,
  ) => a.index - b.index)

  return matches
    .flatMap(match => {
      const candidates = suggestions.filter(item => item.command === match[0] && !item.file)
      const item = candidates.length === 1 ? candidates[0] : undefined
      const startOnly = item?.source === 'Agent commands' || isUpgradeSuggestion({ item })
        || item?.command.startsWith('/prompts:')

      if (startOnly && text.slice(
        0,
        match.index,
      ).trim()) {
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

// Opaque markers keep Markdown from changing the invocation boundaries in the original message.
export function prepareChatTokens({
  text,
  suggestions,
}: {
  text: string
  suggestions: Suggestion[]
}) {
  let prefix = '\uE000'

  const literal = text.replace(
    /&#(?:x0*e000|0*57344);/gi,
    '\uE000',
  )

  while (literal.includes(prefix)) {
    prefix += '\uE000'
  }

  const commands = knownCommands({
    text,
    suggestions,
  })
  const markers = new Map<string, (typeof commands)[number] & { raw: string }>()
  const commandMarkers = new Map<string, string>()
  let end = 0
  const parts = commands.map(command => {
    let marker = commandMarkers.get(command.item.command)

    if (!marker) {
      marker = `${prefix}${commandMarkers.size}\uE001`
      commandMarkers.set(
        command.item.command,
        marker,
      )
    }

    const before = text.slice(
      end,
      command.start,
    )
    markers.set(
      marker,
      {
        ...command,
        raw: text.slice(
          command.start,
          command.end,
        ),
      },
    )
    end = command.end

    return before + marker
  })
  const pattern = new RegExp(
    `(${prefix}\\d+\uE001)`,
    'g',
  )

  return {
    text: parts.join('') + text.slice(end),
    split: ({
      text,
      code = false,
    }: {
      text: string
      code?: boolean
    }) => text.split(pattern).map((
      part,
      index,
      parts,
    ) => {
      const command = markers.get(part)

      if (command) {
        return code && !command.item.command.startsWith('$') ? { text: command.raw } : { item: command.item }
      }

      return {
        text: !code && part.endsWith('\\') && markers.has(parts[index + 1] ?? '') ? part.slice(
          0,
          -1,
        ) : part,
      }
    }),
    restore: ({ text }: { text: string }) => text.replace(
      pattern,
      marker => markers.get(marker)?.raw ?? marker,
    ),
  }
}

export type PreparedChatTokens = ReturnType<typeof prepareChatTokens>
