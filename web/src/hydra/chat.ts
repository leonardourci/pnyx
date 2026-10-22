import { HYDRA_ACTOR, type HydraMessage } from '../../../src/core/model.ts'
import { hydraDelivery, QUIET_REPLY, reportActor } from '../../../src/core/hydra.ts'
import { withoutInjected } from '../../../src/oracle/text.ts'
import type { ThreadEntry } from '../../../src/thread/read.ts'

// A streamed start of Hydra's quiet reply hides too.
const quiet = ({ entry }: { entry: ThreadEntry }) => entry.kind === 'message' && entry.role.startsWith('assistant')
  && Boolean(entry.text.trim()) && QUIET_REPLY.startsWith(entry.text.trim())

export function hydraMessages({
  messages,
  transcript,
  provider,
}: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
  provider?: string
}): ThreadEntry[] {
  transcript = transcript.filter(entry => !quiet({ entry }) && !(provider === 'codex' && ownMessage({ entry })
    && /^# AGENTS\.md instructions(?: for [^\n]*)?\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/.test(entry.text.trim())))
  const remaining = [...transcript]
  const normalized = ({ text }: { text: string }) => text.trim().replace(
    /\s+/g,
    ' ',
  )
  const recorded: ThreadEntry[] = [], replaced = new Set<ThreadEntry>()
  const ownCopies = new Map(transcript.filter(entry => ownMessage({ entry })).map(entry => [
    entry,
    normalized(entry),
  ]))

  // A copy is known by what Pnyx delivered: reports never show, the owner's own words always do.
  for (const message of messages) {
    const report = reportActor({ actor: message.actor })
    const role = message.actor === HYDRA_ACTOR ? 'assistant' : message.actor === 'pnyx' ? 'Pnyx' : 'user'
    const text = message.details ? `${message.text}\n\n${message.details}` : message.text
    const sent = message.context ? `${text}\n\n${message.context}` : text
    // An older server delivered a report as its bare words.
    const reportCopies = [
      hydraDelivery({ message }),
      text,
      sent,
    ]
    // The transcript reader drops harness markup the owner quoted.
    const ownerCopies = [
      text,
      sent,
      withoutInjected({ text }),
      withoutInjected({ text: sent }),
    ]
    const delivered = report ? reportCopies : ownerCopies
    const copies = new Set(delivered.map(copy => normalized({ text: copy })))
    const match = role === 'user' ? remaining.findIndex(entry => {
      const copy = ownCopies.get(entry)

      return copy !== undefined && copies.has(copy)
    }) : -1

    if (match >= 0) {
      const [entry] = remaining.splice(
        match,
        1,
      )

      if (report) {
        replaced.add(entry!)
      } else if (normalized(entry!) !== normalized({ text })) {
        replaced.add(entry!)
        recorded.push({
          ...entry!,
          text,
        })
      }
    } else if (!report) {
      recorded.push({
        id: message.id,
        kind: 'message',
        role,
        text,
        at: message.at,
        ...(message.task ? { task: message.task } : {}),
      })
    }
  }

  return [
    ...recorded,
    ...transcript.filter(entry => !replaced.has(entry)),
  ]
}

export interface ChatComment {
  id: string
  messageId: string
  block: number
  offset: number
  start?: number
  end?: {
    offset: number
    position: number
  }
  quote: string
  text: string
  paragraph?: string
  at?: string
  images?: string[]
}

const SHORT_QUOTE_WORDS = 3

export const sendableComment = ({ comment }: { comment: ChatComment }) =>
  !!comment.text.trim() || !!comment.images?.length

// A quote of three words or fewer travels with its paragraph, so the agent can place it.
export const commentContext = ({
  comment: {
    quote,
    paragraph,
  },
}: { comment: Pick<ChatComment, 'quote' | 'paragraph'> }) =>
  quote.trim().split(/\s+/).length <= SHORT_QUOTE_WORDS && paragraph && paragraph !== quote
    ? paragraph : undefined

export function quoteStart({
  text,
  quote,
  start,
  positions,
}: {
  text: string
  quote: string
  start?: number
  positions?: number[]
}) {
  let at = quote ? text.indexOf(quote) : -1

  if (at < 0 || start === undefined) {
    return at
  }

  for (let next = text.indexOf(
    quote,
    at + 1,
  ); next >= 0; next = text.indexOf(
      quote,
      next + 1,
    )) {
    if (Math.abs((positions?.[next] ?? next) - start) < Math.abs((positions?.[at] ?? at) - start)) {
      at = next
    }
  }

  return at
}

export function quoteSnippet({
  quote,
  context = '',
  start,
}: {
  quote: string
  context?: string
  start?: number
}) {
  const at = quoteStart({
    text: context,
    quote,
    start,
  })

  return at < 0 ? {
    before: '',
    match: quote,
    after: '',
  } : {
    before: context.slice(
      0,
      at,
    ),
    match: quote,
    after: context.slice(at + quote.length),
  }
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

export const COMMENT_NOTE = '> Internal note: no reply needed: numbered comments refer to passages in your earlier reply. Short quotes include their paragraph for context. Address the comments together with the message below.'

const markdownQuote = ({ text }: { text: string }) => text.split('\n')
  .map(line => `> ${line}`)
  .join('\n')

const numberedComment = ({
  comment,
  number,
}: {
  comment: ChatComment
  number: number
}) => {
  const parts = [`${number}. ${markdownQuote({ text: comment.quote })}`]
  const paragraph = commentContext({ comment })

  if (paragraph) {
    parts.push(`Paragraph:\n\n${markdownQuote({ text: paragraph })}`)
  }

  return [
    ...parts,
    comment.text.trim(),
    ...comment.images ?? [],
  ].filter(Boolean).join('\n\n')
}

export function orderedComments({ comments }: { comments: ChatComment[] }) {
  const replies = [...new Set(comments.map(comment => comment.messageId))].map(id => ({
    id,
    at: comments.find(comment => comment.messageId === id && comment.at)?.at || '',
  }))

  if (replies.every(reply => reply.at)) {
    replies.sort((
      a,
      b,
    ) => a.at.localeCompare(b.at))
  }

  const positions = new Map(replies.map((
    reply,
    index,
  ) => [
    reply.id,
    index,
  ]))
  const start = ({ comment }: { comment: ChatComment }) => comment.start
    ?? Math.max(
      0,
      comment.paragraph?.indexOf(comment.quote) ?? 0,
    )

  return [...comments].sort((
    a,
    b,
  ) => {
    if (a.messageId !== b.messageId) {
      return positions.get(a.messageId)! - positions.get(b.messageId)!
    }

    return a.offset - b.offset || start({ comment: a }) - start({ comment: b })
  })
}

export function groupComments({ comments }: { comments: ChatComment[] }) {
  const replies = new Map<string, ChatComment[]>()

  for (const comment of orderedComments({ comments })) {
    const reply = comment.at ?? comment.messageId
    const group = replies.get(reply) ?? []
    group.push(comment); replies.set(
      reply,
      group,
    )
  }

  return replies
}

export function commentReply({
  draft,
  comments,
  firstComment = false,
}: {
  draft: string
  comments: ChatComment[]
  firstComment?: boolean
}): string {
  const ordered = orderedComments({ comments })
  const numbers = new Map(ordered.map((
    comment,
    index,
  ) => [
    comment.id,
    index + 1,
  ]))
  const replies = groupComments({
    comments: ordered.filter(comment => sendableComment({ comment })),
  })

  if (!replies.size) {
    return draft
  }

  const sections = firstComment ? [COMMENT_NOTE] : []

  for (const [
    time,
    items,
  ] of replies) {
    const numbered = items.map(comment => numberedComment({
      comment,
      number: numbers.get(comment.id)!,
    }))
    sections.push(`## Comments on your reply from ${time}\n\n${numbered.join('\n\n')}`)
  }

  sections.push(`## Message\n\n${draft}`)

  return sections.join('\n\n')
}

export function quoteInto({
  draft,
  text,
}: {
  draft: string
  text: string
}): string {
  return [
    draft.trimEnd(),
    markdownQuote({ text: text.trim() }),
  ]
    .filter(Boolean).join('\n\n') + '\n\n'
}

export const ownMessage = ({ entry }: { entry: ThreadEntry }) =>
  entry.kind === 'message' && /^(user|You)( · continued)?$/.test(entry.role)

export interface TurnTiming {
  start: string
  end: string
  reply: string
  latest: boolean
}

// A turn runs from the owner's message to its last entry; task updates belong to no turn.
export function turnTimings({
  entries,
  working,
}: {
  entries: ThreadEntry[]
  working: boolean
}): Map<string, TurnTiming> {
  const turns: {
    start?: string
    last?: ThreadEntry
    reply: string[]
  }[] = []

  for (const entry of entries) {
    if (ownMessage({ entry })) {
      if (!entry.role.endsWith('continued')) {
        turns.push({
          start: entry.at,
          reply: [],
        })
      }
    } else if (!entry.task && turns.length) {
      const turn = turns.at(-1)!
      turn.last = entry

      if (entry.kind === 'message' && entry.role.startsWith('assistant')) {
        turn.reply.push(entry.text)
      }
    }
  }

  const finished = (working ? turns.slice(
    0,
    -1,
  ) : turns).filter(turn => turn.start && turn.last?.at)

  return new Map(finished.map((
    turn,
    index,
  ) => [
    turn.last!.id,
    {
      start: turn.start!,
      end: turn.last!.at!,
      reply: turn.reply.join('\n\n'),
      latest: index === finished.length - 1,
    },
  ]))
}

export function duration({ ms }: { ms: number }) {
  const seconds = Math.max(
    0,
    Math.round(ms / 1000),
  )

  if (seconds < 60) {
    return `${seconds}s`
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

export const clock = ({
  at,
  seconds = false,
}: {
  at: string
  seconds?: boolean
}) => new Date(at).toLocaleTimeString(
  [],
  {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  },
)
