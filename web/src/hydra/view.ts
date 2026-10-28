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

export const slashPrefix = ({
  text,
  cursor,
}: {
  text: string
  cursor: number
}) => /(?:^|\s)(\/[a-z0-9_.:-]*)$/i.exec(text.slice(
  0,
  cursor,
))?.[1] ?? null
export const slashMatches = ({
  command,
  prefix,
}: {
  command: string
  prefix: string
}) => command.replace(
  /^[$/]/,
  '',
).toLowerCase()
  .startsWith(prefix.replace(
    /^\//,
    '',
  ).toLowerCase())
