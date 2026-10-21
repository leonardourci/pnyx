import type { Card, HydraColumn, Link } from '../../../src/core/model.ts'

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

type Columns = Pick<HydraColumn, 'id' | 'title'>[]

const LINK_VERBS: Record<string, string> = {
  open: 'opened',
  merged: 'merged',
  closed: 'closed',
}

const columnName = ({
  columns,
  id,
}: {
  columns: Columns
  id: unknown
}) => columns.find(column => column.id === id)?.title ?? String(id ?? 'none')

const linkName = ({ link }: { link: Link }) => {
  if (link.kind === 'github_pr') {
    return `PR #${link.number}`
  }

  return link.kind === 'linear' ? link.title ?? 'Ticket' : 'Link'
}

const linked = ({ data }: { data: Record<string, unknown> }) => {
  const after = data.after as Link | null
  const link = after ?? data.before as Link | null

  if (!link) {
    return undefined
  }

  const verb = after ? LINK_VERBS[after.state ?? ''] ?? 'linked' : 'removed'

  return {
    state: `${linkName({ link })} ${verb}`,
    note: '',
  }
}

const outcome = ({ data }: { data: Record<string, unknown> }) => {
  const after = data.after as {
    state: string
    note?: string
  } | null

  // A harness closing its session records "ended"; that is not an outcome anyone set.
  if (after?.state === 'ended') {
    return undefined
  }

  return after ? {
    state: after.state,
    note: after.note ?? '',
  } : {
    state: 'Outcome cleared',
    note: '',
  }
}

const renamed = ({ data }: { data: Record<string, unknown> }) => {
  const before = data.before as Record<string, unknown> | undefined

  return before && 'title' in before && typeof data.title === 'string' ? {
    state: 'Renamed',
    note: data.title,
  } : undefined
}

// Only what a person needs to follow the task; hook refreshes, copies, notes and
// delivery receipts stay in History.
export function relevantUpdate({
  cardId,
  event,
  columns,
}: {
  cardId: string
  event: TaskEvent
  columns: Columns
}): Pick<TaskUpdate, 'state' | 'note'> | undefined {
  const data = event.data ?? {}
  const plain = ({
    state,
    note = '',
  }: {
    state: string
    note?: string
  }) => ({
    state,
    note,
  })

  switch (event.type) {
    case 'task.declared': return typeof data.state === 'string'
      ? plain({
        state: data.state,
        note: String(data.note ?? ''),
      })
      : undefined
    case 'task.created': return plain({ state: 'Created' })
    case 'task.launched': return plain({ state: 'Worker started' })
    case 'task.session': return plain({ state: data.after === cardId ? 'Worker attached' : 'Worker detached' })
    case 'task.brief': return plain({ state: 'Brief updated' })
    case 'task.project': return plain({
      state: 'Project changed',
      note: String(data.after ?? 'none'),
    })
    case 'task.reminder': return data.after ? plain({
      state: 'Reminder set',
      note: String(data.after),
    }) : plain({ state: 'Reminder cleared' })
    case 'task.reminder-due': return plain({
      state: 'Reminder due',
      note: event.summary,
    })
    case 'task.visibility': return plain({ state: data.after ? 'Hidden from Hydra' : 'Back on the Hydra' })
    case 'card.moved': return plain({
      state: 'Moved',
      note: `${columnName({
        columns,
        id: data.before,
      })} → ${columnName({
        columns,
        id: data.after,
      })}`,
    })
    case 'card.linked': return linked({ data })
    case 'card.outcome': return outcome({ data })
    case 'card.pushed': return renamed({ data })
    default: return undefined
  }
}

export function taskTimeline({
  card,
  events,
  columns,
}: {
  card: Card
  events: TaskEvent[]
  columns: Columns
}): TaskUpdate[] {
  const updates = new Map<string, TaskUpdate>()

  for (const event of events) {
    const update = relevantUpdate({
      cardId: card.id,
      event,
      columns,
    })

    if (update) {
      updates.set(
        event.id,
        {
          id: event.id,
          at: event.at,
          seq: event.seq,
          ...update,
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
        // A task's first declaration shares its id with the creation event and has no note.
        state: !declaration.note && recorded ? recorded.state : declaration.state,
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
