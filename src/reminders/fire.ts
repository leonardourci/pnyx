import { randomUUID } from 'node:crypto'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { loadHydra, withWriter, type Writer } from '../store/hydra-store.ts'
import { reminderDeadline } from './state.ts'

export function fireReminders({ hydraId, at = new Date().toISOString() }: {
  hydraId: string
  at?: string
}): number {
  const deadline = reminderDeadline({ state: loadHydra({ hydraId }).state })

  if (deadline === undefined || deadline > Date.parse(at)) {
    return 0
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      let fired = 0

      for (const card of Object.values(writer.state.cards)) {
        const reminder = card.reminder

        if (!reminder || reminder.dueAt || Date.parse(reminder.at) > Date.parse(at)) {
          continue
        }

        const column = needsYouColumn({ writer, at })
        const text = `Reminder: ${card.title} (scheduled for ${reminder.at})`
        const decision = hydraEvent({
          state: writer.state,
          meta: { at, actor: 'pnyx', reason: text },
          cardId: card.id,
          change: { type: 'task.reminder-due', data: { reminder: reminder.id, column, message: { task: card.id, action: 'send', text, hydra: hydraConfig({ state: writer.state, id: hydraId }).hydra.id } } },
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

function needsYouColumn({ writer, at }: { writer: Writer; at: string }) {
  const columns = hydraConfig({ state: writer.state }).columns
  const existing = columns.find(column => column.role === 'needs_you')

  if (existing) {
    return existing.id
  }

  const column = { id: `custom:${randomUUID()}` as const, title: 'Needs you', role: 'needs_you' as const }
  const decision = hydraEvent({ state: writer.state, meta: { at, actor: 'pnyx' }, cardId: '$board', change: { type: 'board.columns', data: { before: columns, columns: [...columns, column] } } })

  if ('event' in decision) {
    writer.append({ event: decision.event })
  }

  return column.id
}
