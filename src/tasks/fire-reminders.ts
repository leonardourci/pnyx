import { createHash, randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent, pnyxRunsHydra } from '#hydra/hydra.ts'
import type { HydraMessage } from '#hydra/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import { readSettings } from '#settings/store.ts'
import { dueQuestionReminders } from './question-reminders.ts'
import { deferredQuestions } from './ask-state.ts'
import { reminderDeadline, reminderMessage } from './reminders.ts'

export function fireReminders({
  hydraId,
  at = new Date().toISOString(),
  state = loadHydra({ hydraId }).state,
}: {
  hydraId: string
  at?: string
  state?: HydraState
}): number {
  const time = Date.parse(at)
  const questionsEnabled = readSettings().settings.reviewMinutes > 0

  const questions = ({ state }: { state: HydraState }) => {
    if (!questionsEnabled || !pnyxRunsHydra({ state })) {
      return []
    }

    return dueQuestionReminders({
      state,
      now: time,
    })
  }

  const deadline = reminderDeadline({ state })
  const scheduled = deadline !== undefined && deadline <= time

  if (!scheduled && !questions({ state }).length) {
    return 0
  }

  const id = `reminders:${randomUUID()}`
  const digest = createHash('sha256').update(id)
    .digest('hex')
  const receipt = withWriter({
    hydraId,
    transaction: {
      id,
      digest,
    },
    fn: ({ writer }) => {
      for (const {
        card,
        ask,
      } of deferredQuestions({ state: writer.state }).filter(question => question.at <= time)) {
        const resumed = hydraEvent({
          state: writer.state,
          cardId: card.id,
          meta: {
            at,
            actor: 'pnyx',
          },
          change: {
            type: 'task.ask.deferred',
            data: {
              ask: ask.id,
              until: null,
            },
          },
        })

        if ('event' in resumed) {
          writer.append({ event: resumed.event })
        }
      }

      const recordReceipt = ({ fired }: { fired: number }) => {
        writer.append({
          event: {
            ...base({
              state: writer.state,
              meta: {
                at,
                actor: 'pnyx',
                id,
              },
              cardId: '$board',
            }),
            type: 'apply.recorded',
            data: { digest },
          },
          effects: false,
        })

        return { fired }
      }

      const dueCards = Object.values(writer.state.cards).filter(card => {
        const reminder = card.reminder

        const question = card.asks?.find(ask => ask.id === reminder?.repeat?.question)

        const pending = reminder && (!reminder.dueAt || reminder.repeat)

        return pending && !question?.deferredUntil && Date.parse(reminder.at) <= time
      })
      const pendingQuestions = questions({ state: writer.state })
      const lines: string[] = []
      const taskIds = new Set<string>()

      for (const card of dueCards) {
        const reminder = card.reminder

        if (!reminder) {
          continue
        }

        const column = needsYouColumn({
          writer,
          at,
        })
        const text = reminderMessage({ card })
        let nextAt: string | null | undefined

        if (reminder.repeat) {
          const dueAt = Date.parse(reminder.at)
          const interval = reminder.repeat.everyMs
          const next = dueAt + (Math.floor((time - dueAt) / interval) + 1) * interval
          const nextDate = new Date(next)
          nextAt = Number.isFinite(nextDate.getTime()) ? nextDate.toISOString() : null
        }

        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at,
            actor: 'pnyx',
            reason: text,
          },
          cardId: card.id,
          change: {
            type: 'task.reminder-due',
            data: {
              reminder: reminder.id,
              nextAt,
              grouped: true,
              column,
              message: {
                task: card.id,
                action: 'send',
                text,
                hydra: hydraConfig({ state: writer.state }).hydra.id,
              },
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
          taskIds.add(card.id)

          if (!pendingQuestions.some(question => question.task === card.id)) {
            lines.push(text)
          }
        }
      }

      for (const question of pendingQuestions) {
        const card = writer.state.cards[question.task]
        lines.push(reminderMessage({
          card,
          detail: `still needs your answer. ${question.detail}`,
        }))
        taskIds.add(card.id)
      }

      if (!lines.length) {
        return recordReceipt({ fired: 0 })
      }

      const message: Omit<HydraMessage, 'id' | 'at' | 'actor'> = {
        action: 'send',
        text: lines.join('\n'),
        hydra: hydraConfig({ state: writer.state }).hydra.id,
      }

      if (taskIds.size === 1) {
        message.task = [...taskIds][0]
      }

      if (pendingQuestions.length) {
        message.reminderQuestions = pendingQuestions.map(question => question.key)
      }

      const posted = hydraEvent({
        state: writer.state,
        meta: {
          at,
          actor: 'pnyx',
        },
        cardId: '$hydra',
        change: {
          type: 'hydra.message',
          data: message,
        },
      })

      if ('event' in posted) {
        writer.append({ event: posted.event })
      }

      return recordReceipt({ fired: dueCards.length + pendingQuestions.length })
    },
  })

  if (typeof receipt.fired !== 'number') {
    throw new Error('Reminder batch has no delivery receipt')
  }

  return receipt.fired
}

function needsYouColumn({
  writer,
  at,
}: {
  writer: Writer
  at: string
}) {
  const columns = hydraConfig({ state: writer.state }).columns
  const existing = columns.find(column => column.role === 'needs_you')

  if (existing) {
    return existing.id
  }

  const column = {
    id: `custom:${randomUUID()}` as const,
    title: 'Needs you',
    role: 'needs_you' as const,
  }
  const decision = hydraEvent({
    state: writer.state,
    meta: {
      at,
      actor: 'pnyx',
    },
    cardId: '$board',
    change: {
      type: 'board.columns',
      data: {
        before: columns,
        columns: [
          ...columns,
          column,
        ],
      },
    },
  })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }

  return column.id
}
