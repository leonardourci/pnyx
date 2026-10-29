import type { Link } from '#tasks/delivery/model.ts'

export function safeLink({ link }: { link: Link }): string | undefined {
  try {
    const url = new URL(link.url)

    return [
      'https:',
      'http:',
    ].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export function slashPrefix({
  text,
  cursor,
  chips = [],
}: {
  text: string
  cursor: number
  chips?: {
    from: number
    to: number
  }[]
}): string | null {
  const before = text.slice(
    0,
    cursor,
  )
  const matches = [...before.matchAll(/(?:^|\s)(?=(\/[^@\r\n\u2060]*$))/gu)]
  const query = matches.at(-1)?.[1]

  if (query === undefined) {
    return null
  }

  const start = cursor - query.length
  const insideChip = chips.some(chip => chip.from <= start && start < chip.to)

  return insideChip ? null : query
}
