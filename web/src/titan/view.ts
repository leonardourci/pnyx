// A chip, which the composer's text shows as U+FFFC, ends a command as a space does.
export function slashPrefix({
  text,
  cursor,
}: {
  text: string
  cursor: number
}): string | null {
  const before = text.slice(
    0,
    cursor,
  )
  const matches = [...before.matchAll(/(?:^|[\s\uFFFC])(?=(\/[^@\r\n\uFFFC]*$))/gu)]

  return matches.at(-1)?.[1] ?? null
}

export interface SlashState {
  prefix: string | null
  dismissed: number | null
}

export function slashState({
  text,
  cursor,
  dismissed = null,
}: {
  text: string
  cursor: number
  dismissed?: number | null
}): SlashState {
  const prefix = slashPrefix({
    text,
    cursor,
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
