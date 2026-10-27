import { sendableComment, type ChatComment } from '../hydra/chat.ts'

// Keep each tab's view across reloads and newly served builds.
export type Restore = {
  selected?: string | null
  expanded?: string[]
  revealed?: {
    scope: string
    ids: string[]
  }
  page?: string
  panel?: boolean
  drafts?: Record<string, string>
  scroll?: Record<string, [number, number]>
}

export function savedComments({ comments }: { comments: Record<string, ChatComment[]> }) {
  return Object.fromEntries(Object.entries(comments).map(([
    card,
    items,
  ]) => [
    card,
    items.filter(comment => sendableComment({ comment })),
  ]))
}

export function readComments({ value }: { value: string | null }): Record<string, ChatComment[]> {
  try {
    return savedComments({ comments: JSON.parse(value ?? '{}') as Record<string, ChatComment[]> })
  } catch {
    return {}
  }
}

export function restoreView({ key }: { key: string }): Restore {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Restore
  } catch {
    return {}
  }
}

export const scrollers = () => [...document.querySelectorAll<HTMLElement>('.kanban, [data-column] > .column-cards')]
  .map(el => [
    el.closest('[data-column]')?.getAttribute('data-column') ?? 'kanban',
    el,
  ] as const)

export const hydraViews = new Map<string, Restore>()
