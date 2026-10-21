import type { Card, HydraColumn, Link, PermissionRequest, RepliedEvent } from '../../../src/core/model.ts'

export interface TaskEvent {
  id: string
  seq: number
  at: string
  type: string
  summary: string
  data?: Record<string, unknown>
  actor?: string
  reason?: string
}

export interface TaskUpdate {
  id: string
  at: string
  state: string
  note: string
  seq?: number
  decision?: {
    questionId?: string
    question: string
    answer: string
    actor: string
    reason?: string
  }
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

const decisionActor = ({ actor }: { actor?: string }) => {
  if (actor === 'hydra') {
    return 'Hydra'
  }

  return !actor || actor === 'web' || actor === 'cli' ? 'You' : actor
}

const renamed = ({ data }: { data: Record<string, unknown> }) => {
  const before = data.before as Record<string, unknown> | undefined

  return before && 'title' in before && typeof data.title === 'string' ? {
    state: 'Renamed',
    note: data.title,
  } : undefined
}

// Ordinary delivery receipts stay in recorded history; a delivered answer records its decision.
export function relevantUpdate({
  cardId,
  event,
  columns,
}: {
  cardId: string
  event: TaskEvent
  columns: Columns
}): Pick<TaskUpdate, 'state' | 'note' | 'decision'> | undefined {
  const data = event.data ?? {}

  switch (event.type) {
    case 'card.replied': {
      const reply = data as RepliedEvent['data']

      return reply.state === 'delivered' && reply.decision ? {
        state: 'Decision',
        note: '',
        decision: {
          ...reply.decision,
          actor: decisionActor({ actor: event.actor }),
          reason: event.reason,
        },
      } : undefined
    }
    case 'task.permission': {
      const request = data as unknown as PermissionRequest

      if (!request.questions?.length || request.status === 'pending' || request.status === 'expired') {
        return undefined
      }

      return {
        state: 'Decision',
        note: '',
        decision: {
          question: request.questions.map(question => question.question).join('\n'),
          answer: request.status === 'deny' ? 'Skipped' : request.answers?.map(answer => answer.join(', ')).join('\n') || 'Answered',
          actor: decisionActor({ actor: event.actor }),
          reason: event.reason,
        },
      }
    }
    case 'task.declared': return typeof data.state === 'string' ? {
      state: data.state,
      note: String(data.note ?? ''),
    } : undefined
    case 'task.created': return {
      state: 'Created',
      note: '',
    }
    case 'task.launched': return {
      state: 'Worker started',
      note: '',
    }
    case 'task.session': return {
      state: data.after === cardId ? 'Worker attached' : 'Worker detached',
      note: '',
    }
    case 'task.brief': return {
      state: 'Brief updated',
      note: '',
    }
    case 'task.project': return {
      state: 'Project changed',
      note: String(data.after ?? 'none'),
    }
    case 'task.reminder': return {
      state: data.after ? 'Reminder set' : 'Reminder cleared',
      note: data.after ? String(data.after) : '',
    }
    case 'task.reminder-due': return {
      state: 'Reminder due',
      note: event.summary,
    }
    case 'task.visibility': return {
      state: data.after ? 'Hidden from Hydra' : 'Back on the Hydra',
      note: '',
    }
    case 'card.moved': return {
      state: 'Moved',
      note: `${columnName({
        columns,
        id: data.before,
      })} → ${columnName({
        columns,
        id: data.after,
      })}`,
    }
    case 'card.linked': return linked({ data })
    case 'card.outcome': return outcome({ data })
    case 'card.pushed': return renamed({ data })
    default: return undefined
  }
}

export const MIN_ROWS = 20
export const MAX_PAGES = 10

// Most raw events are hidden, so page back until enough new rows show or history ends.
export async function loadRelevant({
  cardId,
  before,
  pageSize,
  load,
}: {
  cardId: string
  before?: number
  pageSize: number
  load({ before }: { before?: number }): Promise<TaskEvent[]>
}) {
  const found: TaskEvent[] = []
  let cursor = before

  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await load({ before: cursor })
    found.push(...page)

    if (page.length < pageSize) {
      return {
        found,
        more: false,
      }
    }

    const shown = found.filter(event => relevantUpdate({
      cardId,
      event,
      columns: [],
    })).length

    if (shown >= MIN_ROWS) {
      break
    }

    cursor = Math.min(...page.map(event => event.seq))
  }

  return {
    found,
    more: true,
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

    if (!update) {
      continue
    }

    const id = update.decision?.questionId || event.id
    const prior = updates.get(id)

    if (prior?.decision && (!update.decision || (prior.seq ?? 0) > event.seq)) {
      continue
    }

    updates.set(
      id,
      {
        id,
        at: event.at,
        seq: event.seq,
        ...update,
      },
    )
  }

  for (const declaration of card.statusLog ?? []) {
    const recorded = updates.get(declaration.id)

    if (recorded?.decision) {
      continue
    }

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
