import { messageLookupCommand } from '#hydra/message-reference.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { HydraStatus } from '#hydra/model.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'

export interface ChatComment {
  id: string
  messageId: string
  reference?: string
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

// Edits read the newest list and write through, so a removed comment stays removed and back-to-back edits all land.
export function commentUpdates({
  read,
  write,
}: {
  read(): ChatComment[]
  write({ items }: { items: ChatComment[] }): void
}) {
  const edit = ({
    id,
    update,
  }: {
    id: string
    update({ text }: { text: string }): string
  }) => write({
    items: read().map(comment => comment.id === id ? {
      ...comment,
      text: update({ text: comment.text }),
    } : comment),
  })

  return {
    edit,
    remove: ({ id }: { id: string }) => write({
      items: read().filter(comment => comment.id !== id),
    }),
  }
}

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

type Keyed<Entry> = Entry & { renderKey?: string }

// The transcript entry replacing a streamed reply keeps the reply's key, so it is not remounted.
export function keepStreamedKeys<Entry extends ThreadEntry>({
  entries,
  previous,
  keys,
}: {
  entries: Entry[]
  previous: Keyed<Entry>[]
  keys: Map<string, string>
}): Keyed<Entry>[] {
  const ids = new Set(entries.map(entry => entry.id))
  const seen = new Map(previous.map(entry => [
    entry.id,
    entry,
  ]))

  for (const gone of previous) {
    if (!gone.streaming || ids.has(gone.id)) {
      continue
    }

    const settled = entries.find(entry => !seen.has(entry.id) && !entry.streaming
      && entry.kind === gone.kind && entry.role === gone.role && !keys.has(entry.id)
      && entry.text.startsWith(gone.text))

    if (settled) {
      keys.set(
        settled.id,
        gone.id,
      )
    }
  }

  // A key whose live entry is back on the page stays with it, so keys never collide.
  for (const [
    id,
    key,
  ] of keys) {
    if (!ids.has(id) && !ids.has(key)) {
      keys.delete(id)
    }
  }

  return entries.map(entry => {
    const mapped = keys.get(entry.id)
    const renderKey = mapped !== undefined && !ids.has(mapped) ? mapped : undefined
    const before = seen.get(entry.id)

    if (before === entry && before.renderKey === renderKey) {
      return before
    }

    if (before && before.renderKey === renderKey) {
      const fields = Object.entries(entry).filter(([key]) => key !== 'renderKey')
      const previousKeys = Object.keys(before).filter(key => key !== 'renderKey')
      const same = previousKeys.length === fields.length && fields.every(([
        key,
        value,
      ]) =>
        Object.hasOwn(
          before,
          key,
        ) && Reflect.get(
          before,
          key,
        ) === value)

      if (same) {
        return before
      }
    }

    return renderKey === undefined ? entry : {
      ...entry,
      renderKey,
    }
  })
}

const markdownQuote = ({ text }: { text: string }) => text.split('\n')
  .map(line => `> ${line}`.trimEnd())
  .join('\n')

// A comment line that would read as a quote or heading is escaped, so it can't pass for the format.
const commentLines = ({ text }: { text: string }) => text.split('\n')
  .map(line => line.replace(
    /^(\s*)(>|#)/,
    '$1\\$2',
  ))
  .join('\n')

// A short quote's paragraph follows it as a nested quote, so the quote stays every `>` line before the comment.
const quotedComment = ({
  comment,
  number,
}: {
  comment: ChatComment
  number: number
}) => {
  const paragraph = commentContext({ comment })
  const quote = markdownQuote({ text: comment.quote })
  const words = [
    commentLines({ text: comment.text.trim() }),
    ...comment.images ?? [],
  ].filter(Boolean).join('\n')

  const quoted = paragraph ? `${quote}\n>\n${markdownQuote({ text: markdownQuote({ text: paragraph }) })}` : quote

  return `### Comment ${number}\n${quoted}\n\n${words}`
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
    const reply = comment.messageId
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
  hydraId,
  card,
}: {
  draft: string
  comments: ChatComment[]
  hydraId?: string
  card?: string
}): string {
  const replies = groupComments({
    comments: comments.filter(comment => sendableComment({ comment })),
  })

  if (!replies.size) {
    return draft
  }

  const sections = [...replies.values()].map(items => {
    const first = items[0]
    const command = messageLookupCommand({
      reference: first.reference,
      at: first.at,
      hydraId,
      card,
    })
    const reference = first.reference ? `Message reference: ${first.reference}\n` : ''
    const lookup = command ? `\n\n${reference}Read surrounding messages: \`${command}\`` : ''

    return `## Comments on your reply from ${first.at ?? first.messageId}${lookup}\n\n${items.map((
      comment,
      index,
    ) => quotedComment({
      comment,
      number: index + 1,
    })).join('\n\n')}`
  })

  if (draft.trim()) {
    sections.push(`## Message\n${draft}`)
  }

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

// A copied message keeps the task chip it opens with, as the reference a draft turns back into the chip.
export const copiedText = ({
  text,
  task,
  title,
}: {
  text: string
  task?: string
  title?: string
}) => task ? `${taskMention({
  id: task,
  title: title ?? 'Task',
})} ${text}` : text

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

// Shown in the header only while Hydra cannot start: nothing else can happen until a start works.
export const hydraDown = ({ status }: { status?: HydraStatus }) => status?.state === 'down'
  ? `Down since ${clock({ at: status.since })} · retrying`
  : undefined
