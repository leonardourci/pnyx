import type { Card } from '../../../src/core/model.ts'

export interface TaskEvent {
  id: string
  seq: number
  at: string
  type: string
  summary: string
  data?: Record<string, unknown>
}

export interface TaskUpdate {
  id: string
  at: string
  state: string
  note: string
  seq?: number
}

const labels: Record<string, string> = {
  'task.created': 'Created',
  'task.brief': 'Brief updated',
  'task.launched': 'Started',
  'task.session': 'Session changed',
  'task.project': 'Project changed',
  'task.copy': 'Task copy',
  'task.permission': 'Permission',
  'task.reminder': 'Reminder',
  'task.reminder-due': 'Reminder due',
  'task.visibility': 'Visibility',
  'task.retention': 'Hide time',
  'card.moved': 'Moved',
  'card.linked': 'Link updated',
  'card.outcome': 'Outcome',
  'card.noted': 'Note recorded',
  'card.replied': 'Message delivery',
  'card.pushed': 'Task changed',
}

export function taskTimeline({
  card,
  events,
}: {
  card: Card
  events: TaskEvent[]
}): TaskUpdate[] {
  const updates = new Map<string, TaskUpdate>()

  for (const event of events) {
    if (event.type === 'task.declared' && typeof event.data?.state === 'string') {
      updates.set(
        event.id,
        {
          id: event.id,
          at: event.at,
          seq: event.seq,
          state: event.data.state,
          note: String(event.data.note ?? ''),
        },
      )
    } else if (labels[event.type]) {
      updates.set(
        event.id,
        {
          id: event.id,
          at: event.at,
          seq: event.seq,
          state: labels[event.type]!,
          note: event.summary,
        },
      )
    }
  }

  for (const declaration of card.statusLog ?? []) {
    const recorded = updates.get(declaration.id)
    updates.set(
      declaration.id,
      {
        ...recorded,
        ...declaration,
        note: declaration.note || recorded?.note || '',
      },
    )
  }

  return [...updates.values()].reverse().sort((
    a,
    b,
  ) =>
    b.at.localeCompare(a.at) || (b.seq ?? 0) - (a.seq ?? 0))
}
