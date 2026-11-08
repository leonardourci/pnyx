import type { HydraEvent, HydraState } from '#app/model.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { Card, ReminderRepeat } from './model.ts'
import { touch } from './touch.ts'
import { taskDone } from './select.ts'
import { HydraError } from '#store/errors.ts'
import { reminderInterval } from './time.ts'

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
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Use clear without recurrence options',
    })
  }

  if (every === undefined) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Recurring reminders need --every',
    })
  }

  const everyMs = reminderInterval({ text: every })

  if (until !== 'worker-started' && until !== 'question-answered' && until !== 'task-done') {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Choose --until worker-started|question-answered|task-done',
    })
  }

  const repeat: ReminderRepeat = {
    everyMs,
    until,
  }

  if (until === 'question-answered') {
    const ask = card.asks?.find(ask => ask.id === question && ask.audience === 'owner' && !ask.answered && !ask.closed)

    if (!ask) {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: 'Choose an open owner question with --question <id>',
      })
    }

    repeat.question = ask.id
  } else if (question !== undefined) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: '--question goes with --until question-answered',
    })
  }

  return repeat
}

function clearReminder({ card }: { card: Card }) {
  if (card.status?.id === card.reminder?.dueEvent) {
    if (card.reminder?.resume) {
      card.status = card.reminder.resume
    } else {
      delete card.status
    }
  }

  delete card.reminder
}

export function stopReminders({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}) {
  for (const card of Object.values(state.cards)) {
    const repeat = card.reminder?.repeat

    if (!repeat) {
      continue
    }

    const workerStarted = (event.type === 'task.launched' && event.cardId === card.id)
      || (event.type === 'task.session' && event.data.after === card.id && (event.data.working || event.data.handoff))
      || (event.type === 'task.declared' && event.cardId === card.id && event.data.state === 'working')
    const question = card.asks?.find(ask => ask.id === repeat.question)
    const answered = repeat.until === 'question-answered' && (!question || question.answered || question.closed)
    const stopped = taskDone({
      state,
      card,
    }) || answered || (repeat.until === 'worker-started' && workerStarted)

    if (stopped) {
      clearReminder({ card })
      touch({
        card,
        event,
      })
    }
  }
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
      clearReminder({ card })
    } else {
      clearReminder({ card })
      card.reminder = {
        id: event.id,
        at: event.data.after,
      }

      if (event.data.repeat) {
        card.reminder.repeat = structuredClone(event.data.repeat)
      }
    }
  } else {
    const finished = card.reminder?.dueAt && !card.reminder.repeat

    if (card.reminder?.id !== event.data.reminder || finished) {
      return true
    }

    if (!card.reminder.dueAt && card.status) {
      card.reminder.resume = structuredClone(card.status)
    }

    card.reminder.dueAt = event.at
    card.reminder.dueEvent = event.id

    if (event.data.nextAt) {
      card.reminder.at = event.data.nextAt
    }

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
