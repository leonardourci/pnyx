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
}) => /(?:^|\s)(\/[^@\r\n\u2060]*)$/u.exec(text.slice(
  0,
  cursor,
))?.[1] ?? null
