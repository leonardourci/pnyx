import { HYDRA_ACTOR, type HydraMessage } from '../../../src/core/model.ts'
import type { ThreadEntry } from '../../../src/thread/read.ts'

export function hydraMessages({ messages, transcript }: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
}): ThreadEntry[] {
  const remaining = [...transcript]
  const normalized = ({ text }: { text: string }) => text.trim().replace(/\s+/g, ' ')
  const recorded: ThreadEntry[] = []

  for (const message of messages) {
    const role = message.actor === HYDRA_ACTOR ? 'assistant' : message.actor === 'pnyx' ? 'Pnyx' : 'user'
    const text = message.details ? `${message.text}\n\n${message.details}` : message.text
    const match = role === 'user' ? remaining.findIndex(entry => entry.kind === 'message'
      && /^(user|You)( · continued)?$/.test(entry.role) && normalized(entry) === normalized({ text })) : -1

    if (match >= 0) {
      remaining.splice(match, 1)
    } else {
      recorded.push({ id: message.id, kind: 'message', role, text, at: message.at })
    }
  }

  return [...recorded, ...transcript]
}

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

// Transport parts must rejoin before Markdown parsing, even across loaded pages.
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

const markdownQuote = ({ text }: { text: string }) => text.split('\n')
  .map(line => `> ${line}`)
  .join('\n')

const numberedComment = ({ comment, number }: { comment: ChatComment; number: number }) => {
  const parts = [`${number}. ${markdownQuote({ text: comment.quote })}`]
  const shortQuote = comment.quote.trim().split(/\s+/).length <= 3

  if (shortQuote && comment.paragraph && comment.paragraph !== comment.quote) {
    parts.push(`Paragraph:\n\n${markdownQuote({ text: comment.paragraph })}`)
  }

  parts.push(comment.text.trim())

  return parts.join('\n\n')
}

export function commentReply({ draft, comments, firstComment = false }: {
  draft: string
  comments: ChatComment[]
  firstComment?: boolean
}): string {
  const replies = new Map<string, ChatComment[]>()

  for (const comment of comments) {
    if (!comment.text.trim()) {
      continue
    }

    const reply = comment.at ?? comment.messageId
    const group = replies.get(reply) ?? []
    group.push(comment); replies.set(reply, group)
  }

  if (!replies.size) {
    return draft
  }

  const sections = firstComment ? [COMMENT_NOTE] : []

  for (const [time, items] of replies) {
    const numbered = items.map((comment, index) => numberedComment({ comment, number: index + 1 }))
    sections.push(`## Comments on your reply from ${time}\n\n${numbered.join('\n\n')}`)
  }

  sections.push(`## Message\n\n${draft}`)

  return sections.join('\n\n')
}

export function quoteInto({ draft, text }: { draft: string; text: string }): string {
  return [draft.trimEnd(), markdownQuote({ text: text.trim() })]
    .filter(Boolean).join('\n\n') + '\n\n'
}
