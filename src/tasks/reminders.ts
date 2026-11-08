import type { HydraEvent, HydraState } from '#app/model.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { Card } from './model.ts'
import { touch } from './touch.ts'

const REMINDER_WORD_LIMIT = 30
const TITLE_WORD_LIMIT = 10
const REMINDER_PREFIX_WORDS = 2

function reminderExcerpt({
  words,
  limit,
}: {
  words: string[]
  limit: number
}): string {
  const text = words.slice(
    0,
    limit,
  ).join(' ')

  return words.length > limit ? `${text}…` : text
}

export function reminderMessage({
  card,
  detail = 'is due.',
}: {
  card: Pick<Card, 'id' | 'title'>
  detail?: string
}): string {
  const titleWords = card.title.trim().split(/\s+/)
  const title = reminderExcerpt({
    words: titleWords,
    limit: TITLE_WORD_LIMIT,
  })
  const mention = taskMention({
    id: card.id,
    title,
  })
  const remaining = REMINDER_WORD_LIMIT - REMINDER_PREFIX_WORDS - Math.min(
    titleWords.length,
    TITLE_WORD_LIMIT,
  )
  const summary = reminderExcerpt({
    words: detail.trim().split(/\s+/),
    limit: remaining,
  })

  return `- Reminder: ${mention} ${summary}`
}

export function waitingReminders({ state }: { state: HydraState }) {
  return Object.values(state.cards)
    .filter(card => card.reminder && !card.reminder.dueAt)
    .map(card => ({
      task: card.id,
      title: card.title,
      at: card.reminder!.at,
      ...(card.project ? { project: card.project } : {}),
    }))
    .sort((
      a,
      b,
    ) => Date.parse(a.at) - Date.parse(b.at) || a.task.localeCompare(b.task))
}

export function reminderDeadline({ state }: { state: HydraState }): number | undefined {
  const at = waitingReminders({ state })[0]?.at

  return at ? Date.parse(at) : undefined
}

export function applyReminder({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'task.reminder' && event.type !== 'task.reminder-due') {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  if (event.type === 'task.reminder') {
    if (event.data.after === null) {
      delete card.reminder
    } else {
      card.reminder = {
        id: event.id,
        at: event.data.after,
      }
    }
  } else {
    if (card.reminder?.id !== event.data.reminder || card.reminder.dueAt) {
      return true
    }

    card.reminder.dueAt = event.at
    card.column = event.data.column
    card.hidden = false
    delete card.expired
    const declaration = {
      id: event.id,
      at: event.at,
      actor: event.actor,
      state: 'needs_you' as const,
      note: event.data.message.text,
    }
    card.status = declaration
    card.statusLog = [
      ...(card.statusLog ?? []),
      declaration,
    ]
    state.hydraMessages = [
      ...(state.hydraMessages ?? []),
      {
        ...event.data.message,
        id: event.id,
        at: event.at,
        actor: event.actor,
      },
    ]
  }

  touch({
    card,
    event,
  })

  return true
}
