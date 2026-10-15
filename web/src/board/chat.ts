import type { ThreadEntry } from '../../../src/thread/read.ts'

// A comment on one block of an agent message. It travels with the next reply.
export interface ChatComment {
  id: string
  messageId: string
  block: number
  offset: number
  quote: string
  text: string
  paragraph?: string
  at?: string
}

// The transport chunks large messages to stay inside the socket budget. Join
// adjacent parts before parsing Markdown, including after loading an older page.
export function joinMessageParts({ entries }: { entries: ThreadEntry[] }): ThreadEntry[] {
  const result: ThreadEntry[] = []

  for (const entry of entries) {
    const prior = result.at(-1)

    if (entry.messageId && prior?.messageId === entry.messageId &&
      prior.kind === entry.kind && (prior.part ?? 0) + prior.text.length === entry.part) {
      prior.text += entry.text
    } else {
      result.push({ ...entry })
    }
  }

  return result
}

export const COMMENT_NOTE = '> Internal note — no reply needed: numbered comments refer to passages in your earlier reply. Short quotes include their paragraph for context. Address the comments together with the message below.'

export function commentReply({ draft, comments, firstComment = false }: {
  draft: string
  comments: ChatComment[]
  firstComment?: boolean
}): string {
  const filled = comments.filter(c => c.text.trim())

  if (!filled.length) {
    return draft
  }

  const groups = new Map<string, ChatComment[]>()

  for (const comment of filled) {
    const key = comment.at ?? comment.messageId
    groups.set(key, [...(groups.get(key) ?? []), comment])
  }

  const quote = ({ text }: { text: string }) => text.split('\n').map(line => `> ${line}`)
    .join('\n')
  const blocks = [...groups.entries()].map(([time, items]) => `## Comments on your reply from ${time}\n\n` + items.map((c, n) => {
    const context = c.quote.trim().split(/\s+/).length <= 3 && c.paragraph && c.paragraph !== c.quote
      ? `\n\nParagraph:\n\n${quote({ text: c.paragraph })}` : ''

    return `${n + 1}. ${quote({ text: c.quote })}${context}\n\n${c.text.trim()}`
  }).join('\n\n'))

  return [...(firstComment ? [COMMENT_NOTE] : []), ...blocks, `## Message\n\n${draft}`].join('\n\n')
}

// Trailing blank line leaves room to answer under the quote.
export function quoteInto({ draft, text }: { draft: string; text: string }): string {
  const quote = text.trim().split('\n')
    .map(line => `> ${line}`)
    .join('\n')

  return [draft.trimEnd(), quote].filter(Boolean).join('\n\n') + '\n\n'
}
