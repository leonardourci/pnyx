import type { Card, HydraState } from '../core/model.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import { liveTask } from '../core/tasks.ts'

export interface TaskMention {
  id: string
  title: string
}

export function mentionId({ href }: { href: string }): string | undefined {
  if (!/^pnyx-task:[\w%~.-]+$/.test(href)) {
    return undefined
  }

  try {
    return decodeURIComponent(href.slice('pnyx-task:'.length)) || undefined
  } catch {
    return undefined
  }
}

// Only task references add context for Hydra; the other kinds are plain pointers.
export function reference({
  kind,
  value,
  label,
}: {
  kind: 'task' | 'project' | 'column' | 'image' | 'file'
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

export function taskMentions({ text }: { text: string }): TaskMention[] {
  return [...text.matchAll(/\[@((?:\\.|[^\]\\\r\n])*)\]\((pnyx-task:[\w%~.-]+)\)/g)].flatMap(match => {
    const id = mentionId({ href: match[2]! })

    return id ? [
      {
        id,
        title: match[1]!.replace(
          /\\(.)/g,
          '$1',
        ),
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

  return cards.filter(card => card.id !== HYDRA_CARD && liveTask({ card })).flatMap(card => {
    const prompt = card.initialPrompt ?? card.brief ?? ''
    const inTitle = card.title.toLocaleLowerCase().includes(search)
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
