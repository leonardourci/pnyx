import type { HydraState } from '../app/model.ts'
import type { Card } from '../tasks/model.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { liveTask } from '../tasks/select.ts'
import { paragraphs } from '../oracle/text.ts'

export interface TaskMention {
  id: string
  title: string
}

export type ReferenceKind = 'task' | 'project' | 'column' | 'image' | 'file' | 'skill'

// A reference as Pnyx writes it: [@Label](pnyx-<kind>:<encoded value>).
export const REFERENCE = /\[@((?:\\.|[^\]\\\r\n])*)\]\(pnyx-(task|project|column|image|file|skill):([\w%~.-]+)\)/

export const referenceLabel = ({ label }: { label: string }) => label.replace(
  /\\(.)/g,
  '$1',
)

// A hand-written link can carry broken percent-encoding, which decodes to nothing.
export function decodeValue({ value }: { value: string }): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function mentionId({ href }: { href: string }): string | undefined {
  if (!/^pnyx-task:[\w%~.-]+$/.test(href)) {
    return undefined
  }

  return decodeValue({ value: href.slice('pnyx-task:'.length) }) || undefined
}

// Only task references add context for Hydra; the other kinds are plain pointers.
export function reference({
  kind,
  value,
  label,
}: {
  kind: ReferenceKind
  value: string
  label: string
}): string {
  const text = label.replace(
    /\s/g,
    ' ',
  ).replace(
    /[\\[\]`*_<>]/g,
    '\\$&',
  )

  // Parentheses and the other marks encodeURIComponent keeps would end the link early.
  const target = encodeURIComponent(value).replace(
    /[!'()*]/g,
    mark => `%${mark.charCodeAt(0).toString(16)
      .toUpperCase()}`,
  )

  return `[@${text}](pnyx-${kind}:${target})`
}

export const taskMention = ({
  id,
  title,
}: TaskMention): string => reference({
  kind: 'task',
  value: id,
  label: title,
})

// A task chip as Pnyx writes it: [@Title](pnyx-task:<encoded id>).
export const TASK_MENTION = /\[@((?:\\.|[^\]\\\r\n])*)\]\((pnyx-task:[\w%~.-]+)\)/

export function taskMentions({ text }: { text: string }): TaskMention[] {
  return [
    ...text.matchAll(new RegExp(
      TASK_MENTION.source,
      'g',
    )),
  ].flatMap(match => {
    const id = mentionId({ href: match[2]! })

    return id ? [
      {
        id,
        title: referenceLabel({ label: match[1]! }),
      },
    ] : []
  })
}

const TAGGED = new RegExp(`^(?:[-*]\\s+|\\d+\\.\\s+)?(\\*\\*)?(${TASK_MENTION.source})`)

// Only a chip that opens a paragraph or list item tags it; a chip later in a sentence only links.
export function taggedParagraphs({ text }: { text: string }): (TaskMention & { text: string })[] {
  return paragraphs({ text })
    .flatMap(paragraph => paragraph.trimStart().startsWith('```') ? [paragraph] : paragraph.split(/\n(?=[ \t]*(?:[-*]|\d+\.)\s)/))
    .flatMap(block => {
      const trimmed = block.trim()
      const lead = TAGGED.exec(trimmed)
      const mention = lead && taskMentions({ text: lead[2]! })[0]

      if (!mention) {
        return []
      }

      const after = trimmed.slice(lead[0].length)
      const rest = (lead[1] ? after.replace(
        /^[\s:.,\u2013\u2014-]*\*\*/,
        '',
      ) : after).replace(
        /^[\s:.,\u2013\u2014-]+/,
        '',
      )

      return rest ? [
        {
          ...mention,
          text: rest,
        },
      ] : []
    })
}

export function mentionQuery({
  text,
  cursor,
}: {
  text: string
  cursor: number
}): {
  start: number
  query: string
} | null {
  const match = /(?:^|\s)@([^@\n\r[\]()]*)$/.exec(text.slice(
    0,
    cursor,
  ))

  return match ? {
    start: cursor - match[1]!.length - 1,
    query: match[1]!,
  } : null
}

export function matchingTasks({
  cards,
  query,
}: {
  cards: Card[]
  query: string
}): {
  card: Card
  excerpt: string
}[] {
  const search = query.trim().toLocaleLowerCase()
  const compactSearch = search.replace(
    /\s/g,
    '',
  )

  return cards.filter(card => card.id !== HYDRA_CARD && liveTask({ card })).flatMap(card => {
    const prompt = card.initialPrompt ?? card.brief ?? ''
    const title = card.title.toLocaleLowerCase()
    const inTitle = title.includes(search) || compactSearch.length > 0 && title.replace(
      /\s/g,
      '',
    ).includes(compactSearch)
    const index = prompt.toLocaleLowerCase().indexOf(search)

    if (!inTitle && index < 0) {
      return []
    }

    const source = index >= 0 ? prompt : card.title
    const start = Math.max(
      0,
      index - 48,
    )
    const excerpt = `${start ? '…' : ''}${source.slice(
      start,
      start + 180,
    )}${source.length > start + 180 ? '…' : ''}`

    return [
      {
        card,
        excerpt: excerpt || 'No initial prompt',
      },
    ]
  })
}

export function mentionContext({
  state,
  text,
}: {
  state: HydraState
  text: string
}): string {
  const seen = new Set<string>()
  const mentions = taskMentions({ text }).filter(mention => {
    if (seen.has(mention.id)) {
      return false
    }

    seen.add(mention.id)

    return true
  })

  if (!mentions.length) {
    return ''
  }

  return [
    'Referenced tasks (context only):',
    ...mentions.map(mention => {
      const card = Object.hasOwn(
        state.cards,
        mention.id,
      ) ? state.cards[mention.id] : undefined

      if (!card || card.automaticTask || card.id === HYDRA_CARD) {
        return `Task ${mention.id}: ${mention.title}\nUnavailable in this Hydra.`
      }

      const update = card.statusLog?.findLast(status => status.note.trim())?.note ?? 'No update yet.'

      return `Task ${card.id}: ${card.title}\nMentioned as: ${mention.title}\nInitial prompt: ${card.initialPrompt ?? card.brief ?? 'No initial prompt.'}\nLatest update: ${update}`
    }),
  ].join('\n\n')
}
