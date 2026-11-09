import type { HydraState } from '#app/model.ts'
import { askWording, openAsks } from './ask-state.ts'
import type { Ask, Card } from './model.ts'
import { liveTask } from './select.ts'

export const QUESTION_REMINDER_MS = 4 * 60 * 60_000

export function questionReminder({
  state,
  card,
  ask,
  now,
}: {
  state: HydraState
  card: Card
  ask: Ask
  now: number
}) {
  if (ask.audience !== 'owner' || ask.answered || ask.closed || ask.deferredUntil || !liveTask({ card })) {
    return undefined
  }

  let key = `${card.id}:${ask.id}`

  if (ask.answerRound) {
    key += `:${ask.answerRound}`
  }

  const at = ask.reaskedAt ?? ask.escalated?.at ?? ask.at
  const last = state.questionReminders?.[key] ?? state.hydraReview?.reminders[key]
  const reminded = last && now - Date.parse(last) < QUESTION_REMINDER_MS
  const dueAt = card.reminder?.dueAt
  const scheduled = dueAt && now - Date.parse(dueAt) < QUESTION_REMINDER_MS

  if (now - Date.parse(at) < QUESTION_REMINDER_MS || reminded || scheduled) {
    return undefined
  }

  return {
    task: card.id,
    key,
    detail: [
      `${ask.id}: ${askWording({ ask }).question}`,
      ask.url,
    ].filter(Boolean).join(' '),
  }
}

export function dueQuestionReminders({
  state,
  now,
}: {
  state: HydraState
  now: number
}) {
  return Object.values(state.cards).flatMap(card => openAsks({ card }).flatMap(ask => {
    const reminder = questionReminder({
      state,
      card,
      ask,
      now,
    })

    return reminder ? [reminder] : []
  }))
}
