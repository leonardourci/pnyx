import { HYDRA_ACTOR } from '#app/actors.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'

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
        actor: HYDRA_ACTOR,
      },
    ]
  }

  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}
