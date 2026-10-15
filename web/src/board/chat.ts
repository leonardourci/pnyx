import type { ThreadEntry } from '../../../src/thread/read.ts'

// A comment on one block of an agent message. It travels with the next reply.
export interface ChatComment {
  id: string
  messageId: string
  block: number
  offset: number
  quote: string
  text: string
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

// Each comment becomes a fenced pnyx-comment block quoting its text, with a fence
// longer than any backtick run inside so quoted code cannot close it early.
export function commentReply({ draft, comments }: {
  draft: string
  comments: ChatComment[]
}): string {
  const blocks = comments.filter(c => c.text.trim()).map(c => {
    const body = c.quote.split('\n').map(line => `> ${line}`)
      .join('\n') + '\n\n' + c.text.trim()
    const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map(run => run.length))
    const fence = '`'.repeat(longest + 1)

    return `${fence}pnyx-comment block=${c.block + 1} msg=${JSON.stringify(c.messageId)} offset=${c.offset}\n${body}\n${fence}`
  })

  return [draft, ...blocks].filter(text => text.trim()).join('\n\n')
}

// Trailing blank line leaves room to answer under the quote.
export function quoteInto({ draft, text }: { draft: string; text: string }): string {
  const quote = text.trim().split('\n')
    .map(line => `> ${line}`)
    .join('\n')

  return [draft.trimEnd(), quote].filter(Boolean).join('\n\n') + '\n\n'
}
