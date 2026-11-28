import { inform } from '#app/command-notices.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { taskMention } from '#titan/mentions.ts'
import type { Card, ReminderRepeat } from './model.ts'
import { touch } from './touch.ts'
import { taskDone } from './select.ts'
import { TitanError } from '#store/errors.ts'
import { reminderInterval } from './time.ts'
import { cloneValue } from '#app/json-copy.ts'
import { deferredQuestions } from './ask-state.ts'

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

export function reminderTaskMention({ card }: { card: Pick<Card, 'id' | 'title'> }): string {
  return taskMention({
    id: card.id,
    title: reminderExcerpt({
      words: card.title.trim().split(/\s+/),
      limit: TITLE_WORD_LIMIT,
    }),
  })
}

export function reminderMessage({
  card,
  detail = 'is due.',
}: {
  card: Pick<Card, 'id' | 'title'>
  detail?: string
}): string {
  const titleWords = card.title.trim().split(/\s+/)
  const mention = reminderTaskMention({ card })
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

export function waitingReminders({ state }: { state: TitanState }) {
  return Object.values(state.cards)
    .filter(card => card.reminder && (!card.reminder.dueAt || card.reminder.repeat))
    .map(card => ({
      task: card.id,
      title: card.title,
      at: card.reminder!.at,
      repeat: card.reminder!.repeat,
      ...(card.project ? { project: card.project } : {}),
    }))
    .sort((
      a,
      b,
    ) => Date.parse(a.at) - Date.parse(b.at) || a.task.localeCompare(b.task))
}

export function reminderRepeat({
  card,
  when,
  every,
  until,
  question,
}: {
  card: Card
  when: string
  every?: string
  until?: string
  question?: string
}): ReminderRepeat | undefined {
  if (every === undefined && until === undefined && question === undefined) {
    return undefined
  }

  if (when === 'clear') {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: 'Use clear without recurrence options',
    })
  }

  if (every === undefined) {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: 'Recurring reminders need --every',
    })
  }

  const everyMs = reminderInterval({ text: every })

  if (until !== 'worker-started' && until !== 'question-answered' && until !== 'task-done') {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: 'Choose --until worker-started|question-answered|task-done',
    })
  }

  if (until === 'task-done' && taskDone({ card })) {
    inform({
      task: card.id,
      reason: 'Task is already done; its recurring reminder stops immediately',
      clear: `Review the recurring reminder on task ${card.id} in the UI.`,
    })
  }

  const repeat: ReminderRepeat = {
    everyMs,
    until,
  }

  if (until === 'question-answered') {
    const ask = card.asks?.find(ask => ask.id === question)

    if (!ask) {
      throw new TitanError({
        code: 'VALIDATION_ERROR',
        message: 'Choose an open owner question with --question <id>',
      })
    }

    if (ask.answered || ask.closed || ask.audience !== 'owner') {
      inform({
        task: card.id,
        reason: 'Question is answered, closed or directed to Titan; recurrence uses its recorded answer state',
        clear: `Review the reminder on task ${card.id} in the UI.`,
      })
    }

    repeat.question = ask.id
  } else if (question !== undefined) {
    throw new TitanError({
      code: 'VALIDATION_ERROR',
      message: '--question goes with --until question-answered',
    })
  }

  return repeat
}

function clearReminder({ card }: { card: Card }) {
  delete card.reminder
}

export function stopReminders({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
}) {
  for (const card of Object.values(state.cards)) {
    const repeat = card.reminder?.repeat

    if (!repeat) {
      continue
    }

    const workerStarted = (event.type === 'task.launched' && event.cardId === card.id)
      || (event.type === 'task.session' && event.data.after === card.id && (event.data.working || event.data.handoff))

    const question = card.asks?.find(ask => ask.id === repeat.question)
    const answered = repeat.until === 'question-answered' && (!question || question.answered || question.closed)
    const done = repeat.until === 'task-done' && taskDone({ card })
    const stopped = done || answered || (repeat.until === 'worker-started' && workerStarted)

    if (stopped) {
      clearReminder({ card })
      touch({
        card,
        event,
      })
    }
  }
}

export function reminderDeadline({ state }: { state: TitanState }): number | undefined {
  const deadlines = deferredQuestions({ state }).map(question => question.at)
    .filter(Number.isFinite)

  for (const card of Object.values(state.cards)) {
    const reminder = card.reminder

    if (reminder && (!reminder.dueAt || reminder.repeat)) {
      const question = card.asks?.find(ask => ask.id === reminder.repeat?.question)
      const activeAt = question?.deferredUntil ?? reminder.at
      const deadline = Math.max(
        Date.parse(reminder.at),
        Date.parse(activeAt),
      )

      if (Number.isFinite(deadline)) {
        deadlines.push(deadline)
      }
    }
  }

  return deadlines.length ? Math.min(...deadlines) : undefined
}

export function applyReminder({
  state,
  event,
}: {
  state: TitanState
  event: TitanEvent
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
      clearReminder({ card })
    } else {
      clearReminder({ card })
      card.reminder = {
        id: event.id,
        at: event.data.after,
      }

      if (event.data.repeat) {
        card.reminder.repeat = cloneValue({ value: event.data.repeat })
      }
    }
  } else {
    const finished = card.reminder?.dueAt && !card.reminder.repeat

    if (card.reminder?.id !== event.data.reminder || finished) {
      return true
    }

    const reminder = card.reminder
    reminder.dueAt = event.at
    reminder.dueEvent = event.id

    if (event.data.nextAt) {
      reminder.at = event.data.nextAt
    } else if (event.data.nextAt === null) {
      delete reminder.repeat
    }

    card.hidden = false
    delete card.expired

    if (!event.data.grouped) {
      state.titanMessages = [
        ...(state.titanMessages ?? []),
        {
          ...event.data.message,
          id: event.id,
          at: event.at,
          actor: event.actor,
        },
      ]
    }
  }

  touch({
    card,
    event,
  })

  return true
}
