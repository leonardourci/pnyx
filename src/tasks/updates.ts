import type { HydraEvent } from '#app/model.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import type { HydraColumn } from './columns-model.ts'
import type { Ask, RepliedEvent } from './model.ts'
import type { Link } from '#tasks/delivery/model.ts'
import type { PermissionRequest } from '#workers/model.ts'
import { reportActor } from '#hydra/hydra.ts'
import { taskMentions } from '#hydra/mentions.ts'

// Updates and the CLI history name a brief change the same way; a rewritten Intent is never folded as bookkeeping.
export const briefChange = ({ data }: {
  data: {
    before?: unknown
    after?: unknown
    intent?: unknown
  }
}) =>
  !data.intent ? 'Brief updated' : data.before === data.after ? 'Intent updated' : 'Brief and Intent updated'

export interface TaskEvent {
  id: string
  seq: number
  at: string
  type: string
  summary: string
  data?: Record<string, unknown>
  actor?: string
  reason?: string
  details?: string
}

// hydra: a chat paragraph that starts with the task's chip; told: Hydra to the worker.
export type UpdateKind = 'ask' | 'hydra' | 'told' | 'decision' | 'status' | 'worker' | 'link' | 'created' | 'moved' | 'renamed' | 'done' | 'report' | 'plain'

export interface UpdateDecision {
  questionId?: string
  question: string
  answer: string
  actor: string
  reason?: string
  choice?: string
  ask?: {
    from?: string
    to?: Ask['audience']
    context?: string
    details?: string
    options?: Ask['options']
    recommended?: number
    escalation?: {
      reason?: string
      question?: string
      context?: string
    }
  }
}

export interface TaskUpdate {
  id: string
  at: string
  kind: UpdateKind
  state: string
  note: string
  seq?: number
  link?: Link
  decision?: UpdateDecision
}

type Row = Omit<TaskUpdate, 'id' | 'at' | 'seq'> & {
  // A note recorded later than the moment it describes carries its own time.
  at?: string
}

export type UpdateColumns = Pick<HydraColumn, 'id' | 'title' | 'role'>[]

const LINK_VERBS: Record<string, string> = {
  merged: 'merged',
  closed: 'closed',
}

const HARNESSES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

const INTENT = /^Captain's intent:\s*/
const NEEDS_DECISION = /^needs-decision(?: \[([^\]]+)\])?:\s*([\s\S]+)$/
const RESOLVED = /^resolved(?: \[([^\]]+)\])?:\s*(?:answered:\s*)?([\s\S]+)$/

const column = ({
  columns,
  id,
}: {
  columns: UpdateColumns
  id: unknown
}) => columns.find(c => c.id === id)

const linkName = ({ link }: { link: Link }) => {
  if (link.kind === 'github_pr') {
    return `PR #${link.number}`
  }

  return link.kind === 'linear' ? link.title ?? 'Ticket' : 'Link'
}

const linked = ({ data }: { data: Record<string, unknown> }): Row | undefined => {
  const before = data.before as Link | null
  const after = data.after as Link | null

  if (!after) {
    return before ? {
      kind: 'link',
      state: 'Link removed',
      note: '',
      link: before,
    } : undefined
  }

  if (!before) {
    return {
      kind: 'link',
      state: 'Link attached',
      note: '',
      link: after,
    }
  }

  // A refresh that finds the same state says nothing new.
  const verb = after.state !== before.state ? LINK_VERBS[after.state ?? ''] : undefined

  return verb ? {
    kind: 'link',
    state: `${linkName({ link: after })} ${verb}`,
    note: '',
    link: after,
  } : undefined
}

const outcome = ({ data }: { data: Record<string, unknown> }): Row | undefined => {
  const after = data.after as {
    state: string
    note?: string
  } | null

  // A harness closing its session records "ended"; that is not an outcome anyone set.
  if (after?.state === 'ended') {
    return undefined
  }

  if (after?.state === 'done') {
    return {
      kind: 'done',
      state: 'Done',
      note: after.note ?? '',
    }
  }

  return after ? {
    kind: 'plain',
    state: after.state,
    note: after.note ?? '',
  } : {
    kind: 'plain',
    state: 'Outcome cleared',
    note: '',
  }
}

const decisionActor = ({ actor }: { actor?: string }) => {
  if (actor === 'hydra') {
    return 'Hydra'
  }

  return ownerActor({ actor }) ? 'You' : actor!
}

const asker = ({ actor = '' }: { actor?: string }) => {
  if (actor === HYDRA_ACTOR) {
    return 'Hydra'
  }

  return reportActor({ actor }) ? 'The worker' : 'You'
}

const renamed = ({ data }: { data: Record<string, unknown> }): Row | undefined => {
  const before = data.before as Record<string, unknown> | undefined

  return before && 'title' in before && typeof data.title === 'string' ? {
    kind: 'renamed',
    state: 'Renamed',
    note: data.title,
  } : undefined
}

const replied = ({
  data,
  actor,
}: {
  data: RepliedEvent['data']
  actor?: string
}): Row | undefined => {
  if (data.state !== 'queued' || !data.text?.trim() || data.control || data.decision || data.answers) {
    return undefined
  }

  if (actor === 'hydra') {
    return {
      kind: 'told',
      state: 'Told the worker',
      note: data.text,
    }
  }

  return ownerActor({ actor }) ? {
    kind: 'ask',
    state: 'You asked',
    note: data.text,
  } : undefined
}

// Transcript summaries a harvest collects stay out.
const noted = ({ data }: { data: Record<string, unknown> }): Row | undefined => {
  const text = String(data.text ?? '')
  const at = typeof data.at === 'string' ? { at: data.at } : {}

  if (data.source === 'hydra') {
    return {
      kind: 'hydra',
      state: 'Hydra replied',
      note: text,
      ...at,
    }
  }

  if (data.source === 'owner') {
    return {
      kind: 'ask',
      state: 'You asked',
      note: text,
      ...at,
    }
  }

  if (data.source !== 'firstmate') {
    return undefined
  }

  if (data.kind === 'context' && INTENT.test(text)) {
    return {
      kind: 'ask',
      state: 'You asked',
      note: text.replace(
        INTENT,
        '',
      ),
      ...at,
    }
  }

  const asked = NEEDS_DECISION.exec(text)
  const resolved = RESOLVED.exec(text)

  if (data.kind !== 'decision' || !(asked || resolved)) {
    return undefined
  }

  return {
    kind: 'decision',
    state: 'Decision',
    note: '',
    decision: {
      questionId: `firstmate:${(asked ?? resolved)![1] ?? 'default'}`,
      question: asked?.[2] ?? '',
      answer: resolved?.[2] ?? '',
      actor: 'Hydra',
    },
    ...at,
  }
}

// Receipts, worker attachments, reminders and project changes stay in recorded history.
function updateRow({
  event,
  columns,
}: {
  event: TaskEvent
  columns: UpdateColumns
}): Row | undefined {
  const data = event.data ?? {}

  switch (event.type) {
    case 'project.refreshed': return {
      kind: 'status',
      state: `Project copy ${data.state}`,
      note: `${data.path}${data.reason ? `: ${data.reason}` : ''}`,
    }
    case 'card.replied': {
      const reply = data as RepliedEvent['data']

      return reply.state === 'delivered' && reply.decision ? {
        kind: 'decision',
        state: 'Decision',
        note: '',
        decision: {
          ...reply.decision,
          actor: reply.decision.fromMessage ? 'You' : decisionActor({ actor: event.actor }),
          reason: event.reason,
        },
      } : replied({
        data: reply,
        actor: event.actor,
      })
    }
    case 'task.asked': {
      const ask = data as unknown as Ask

      return {
        kind: 'decision',
        state: 'Decision',
        note: '',
        decision: {
          questionId: ask.id,
          question: ask.question,
          answer: '',
          actor: '',
          ask: {
            from: asker({ actor: event.actor }),
            to: ask.audience,
            ...(ask.context ? { context: ask.context } : {}),
            ...(ask.details ? { details: ask.details } : {}),
            ...(ask.options ? { options: ask.options } : {}),
            ...(ask.recommended ? { recommended: ask.recommended } : {}),
          },
        },
      }
    }
    case 'task.ask.closed': return {
      kind: 'status',
      state: 'Question closed',
      note: `${data.reason} (${data.evidence})`,
    }
    case 'task.ask.reopened': return {
      kind: 'status',
      state: 'Question reopened',
      note: String(data.ask),
    }
    case 'task.ask.escalated': return {
      kind: 'decision',
      state: 'Decision',
      note: '',
      decision: {
        questionId: String(data.ask),
        question: '',
        answer: '',
        actor: '',
        ask: {
          to: 'owner',
          escalation: {
            ...(event.reason ? { reason: event.reason } : {}),
            ...(typeof data.question === 'string' ? { question: data.question } : {}),
            ...(typeof data.context === 'string' ? { context: data.context } : {}),
          },
        },
      },
    }
    case 'task.permission': {
      const request = data as unknown as PermissionRequest

      if (!request.questions?.length || request.status === 'pending' || request.status === 'expired') {
        return undefined
      }

      return {
        kind: 'decision',
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
    // A message to the task also queues its reply, which already shows as the ask.
    case 'hydra.message': {
      if (reportActor({ actor: event.actor ?? '' }) && typeof data.text === 'string' && data.text.trim()) {
        return {
          kind: 'report',
          state: data.kind === 'progress' ? 'Progress' : 'Reported to Hydra',
          note: data.text,
        }
      }

      if (typeof data.answers === 'string') {
        const decision: UpdateDecision = {
          questionId: data.answers,
          question: '',
          answer: String(data.text ?? ''),
          actor: data.fromMessage ? 'You' : decisionActor({ actor: event.actor }),
        }

        if (typeof data.choice === 'string') {
          decision.choice = data.choice
        }

        if (event.reason) {
          decision.reason = event.reason
        }

        return {
          kind: 'decision',
          state: 'Decision',
          note: '',
          decision,
        }
      }

      const ownerMessage = ownerActor({ actor: event.actor }) && data.action === 'send'
      const meaningful = typeof data.text === 'string' && data.text.trim()

      if (!event.id.startsWith('task-context:') && ownerMessage && meaningful) {
        return {
          kind: 'ask',
          state: 'You asked',
          note: String(data.text),
        }
      }

      return undefined
    }
    case 'task.declared': return typeof data.state === 'string' ? {
      kind: data.state === 'done' ? 'done' : 'status',
      state: data.state,
      note: String(data.note ?? ''),
    } : undefined
    case 'task.created': return {
      kind: 'created',
      state: 'Created',
      note: event.reason ?? '',
    }
    case 'task.launched': return {
      kind: 'worker',
      state: 'Worker started',
      note: [
        HARNESSES[String(data.harness)],
        event.reason,
      ].filter(Boolean).join('. '),
    }
    case 'task.brief': return {
      kind: 'plain',
      state: briefChange({ data }),
      note: event.reason ?? '',
    }
    case 'task.reminder-due': return {
      kind: 'plain',
      state: 'Reminder due',
      note: event.summary,
    }
    case 'task.visibility': return data.automatic ? undefined : {
      kind: 'plain',
      state: data.after ? 'Hidden from Hydra' : 'Back on the Hydra',
      note: event.reason ?? '',
    }
    case 'card.moved': {
      if (data.before === data.after) {
        return undefined
      }

      const after = column({
        columns,
        id: data.after,
      })

      return {
        kind: after?.role === 'done' ? 'done' : 'moved',
        state: `Moved to ${after?.title ?? String(data.after ?? 'none')}`,
        note: event.reason ?? '',
      }
    }
    case 'card.linked': return linked({ data })
    case 'card.outcome': return outcome({ data })
    case 'card.pushed': return renamed({ data })
    case 'card.noted': return noted({ data })
    default: return undefined
  }
}

export function relevantUpdate({
  event,
  columns,
}: {
  event: TaskEvent
  columns: UpdateColumns
}): Row | undefined {
  const row = updateRow({
    event,
    columns,
  })

  if (!row || !event.details?.trim()) {
    return row
  }

  return {
    ...row,
    note: [
      row.note,
      event.details,
    ].filter(Boolean).join('\n\n'),
  }
}

// A Hydra chat message belongs to its task and to every task it names with a chip.
const taggedTasks = ({ event }: { event: HydraEvent }): string[] => {
  if (event.type !== 'hydra.message') {
    return []
  }

  const mentioned = taskMentions({ text: event.data.text }).map(mention => mention.id)

  return event.data.task ? [
    event.data.task,
    ...mentioned,
  ] : mentioned
}

export function tagsTask({
  event,
  ids,
}: {
  event: HydraEvent
  ids: Set<string>
}): boolean {
  return taggedTasks({ event }).some(id => ids.has(id))
}

// Every task whose history lists the event: its own card and the tasks it tags.
export const historyTasks = ({ event }: { event: HydraEvent }): string[] => [
  ...new Set([
    event.cardId,
    ...taggedTasks({ event }),
  ]),
]

// The tasks whose Updates list shows the event.
export const updateTasks = ({ event }: { event: HydraEvent }): string[] =>
  showsUpdate({ event }) ? historyTasks({ event }) : []

// Whether the event adds or changes a row in its task's Updates list.
export function showsUpdate({ event }: { event: HydraEvent }): boolean {
  return !!updateRow({
    event: {
      ...event,
      summary: '',
    } as TaskEvent,
    columns: [],
  })
}
