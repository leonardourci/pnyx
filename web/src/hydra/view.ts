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

export interface SlashState {
  prefix: string | null
  dismissed: number | null
}

export function slashState({
  text,
  cursor,
  chips,
  dismissed = null,
}: {
  text: string
  cursor: number
  chips?: {
    from: number
    to: number
  }[]
  dismissed?: number | null
}): SlashState {
  const prefix = slashPrefix({
    text,
    cursor,
    chips,
  })
  const start = prefix === null ? null : cursor - prefix.length

  if (start !== null && start === dismissed) {
    return {
      prefix: null,
      dismissed,
    }
  }

  return {
    prefix,
    dismissed: null,
  }
}
