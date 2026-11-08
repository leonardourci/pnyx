import { randomUUID } from 'node:crypto'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { reminderDeadline, reminderMessage } from './reminders.ts'

export function fireReminders({
  hydraId,
  at = new Date().toISOString(),
  state = loadHydra({ hydraId }).state,
}: {
  hydraId: string
  at?: string
  // The server passes the Hydra it already holds; the writer below reads it again under the lock.
  state?: HydraState
}): number {
  const deadline = reminderDeadline({ state })

  if (deadline === undefined || deadline > Date.parse(at)) {
    return 0
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      let fired = 0

      for (const card of Object.values(writer.state.cards)) {
        const reminder = card.reminder

        const waiting = reminder && (!reminder.dueAt || reminder.repeat)

        if (!waiting || Date.parse(reminder.at) > Date.parse(at)) {
          continue
        }

        const column = needsYouColumn({
          writer,
          at,
        })
        const text = reminderMessage({ card })
        let nextAt: string | undefined

        if (reminder.repeat) {
          const due = Date.parse(reminder.at)
          const interval = reminder.repeat.everyMs
          const next = due + (Math.floor((Date.parse(at) - due) / interval) + 1) * interval
          nextAt = new Date(next).toISOString()
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
              column,
              message: {
                task: card.id,
                action: 'send',
                text,
                hydra: hydraConfig({
                  state: writer.state,
                  id: hydraId,
                }).hydra.id,
              },
            },
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
          fired++
        }
      }

      return fired
    },
  })
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
