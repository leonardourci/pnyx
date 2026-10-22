import type { Ask, Card, HydraColumn, Link, PermissionRequest, RepliedEvent } from '../../../src/core/model.ts'
import { HYDRA_ACTOR, ownerActor } from '../../../src/core/model.ts'
import { reportActor } from '../../../src/core/hydra.ts'
import { mentionId, TASK_MENTION } from '../../../src/mentions/mentions.ts'

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

// hydra: a chat paragraph that starts with the task's chip; told: Hydra to the worker.
export type UpdateKind = 'ask' | 'hydra' | 'told' | 'decision' | 'status' | 'worker' | 'link' | 'created' | 'moved' | 'renamed' | 'done' | 'plain'

export interface UpdateDecision {
  questionId?: string
  question: string
  answer: string
  actor: string
  reason?: string
  choice?: string
  // A structured question's own parts, from its asking and any escalation.
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

type Columns = Pick<HydraColumn, 'id' | 'title' | 'role'>[]

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
const OWN_CHIP = new RegExp(`^${TASK_MENTION.source}\\s*`)

const column = ({
  columns,
  id,
}: {
  columns: Columns
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
export function relevantUpdate({
  event,
  columns,
}: {
  event: TaskEvent
  columns: Columns
}): Row | undefined {
  const data = event.data ?? {}

  switch (event.type) {
    case 'card.replied': {
      const reply = data as RepliedEvent['data']

      return reply.state === 'delivered' && reply.decision ? {
        kind: 'decision',
        state: 'Decision',
        note: '',
        decision: {
          ...reply.decision,
          actor: decisionActor({ actor: event.actor }),
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
    case 'hydra.message': return typeof data.answers === 'string' ? {
      kind: 'decision',
      state: 'Decision',
      note: '',
      decision: {
        questionId: data.answers,
        question: '',
        answer: String(data.text ?? ''),
        actor: decisionActor({ actor: event.actor }),
        ...(typeof data.choice === 'string' ? { choice: data.choice } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      },
    } : !event.id.startsWith('task-context:') && ownerActor({ actor: event.actor })
      && data.action === 'send' && typeof data.text === 'string' && data.text.trim() ? {
        kind: 'ask',
        state: 'You asked',
        note: data.text,
      } : undefined
    case 'task.declared': return typeof data.state === 'string' ? {
      kind: data.state === 'done' ? 'done' : 'status',
      state: data.state,
      note: String(data.note ?? ''),
    } : undefined
    case 'task.created': return {
      kind: 'created',
      state: 'Created',
      note: '',
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
      state: 'Brief updated',
      note: '',
    }
    case 'task.reminder-due': return {
      kind: 'plain',
      state: 'Reminder due',
      note: event.summary,
    }
    case 'task.visibility': return data.automatic ? undefined : {
      kind: 'plain',
      state: data.after ? 'Hidden from Hydra' : 'Back on the Hydra',
      note: '',
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

export const MIN_ROWS = 20
export const MAX_PAGES = 10

// Most raw events are hidden, so page back until enough new rows show or history ends.
export async function loadRelevant({
  before,
  pageSize,
  load,
}: {
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

// The card already names its task, so its own chip would only repeat the title.
const withoutOwnChip = ({
  text,
  cardId,
}: {
  text: string
  cardId: string
}) => {
  const lead = OWN_CHIP.exec(text)

  return lead && mentionId({ href: lead[2]! }) === cardId ? text.slice(lead[0].length) : text
}

const mergeDecisions = ({
  prior,
  next,
}: {
  prior: UpdateDecision
  next: UpdateDecision
}): UpdateDecision => ({
  ...prior,
  question: prior.question || next.question,
  // The first answer recorded is the one that settled it.
  answer: prior.answer || next.answer,
  actor: prior.answer ? prior.actor : next.actor,
  reason: prior.reason ?? next.reason,
  ...(!prior.answer && next.choice ? { choice: next.choice } : {}),
  ...(prior.ask || next.ask ? {
    ask: {
      ...prior.ask,
      ...next.ask,
    },
  } : {}),
})

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
  // Firstmate reuses a decision key, the default one most of all: a question after its answer is a new decision.
  const rounds = new Map<string, number>()
  const answered = new Set<string>()
  let intent = ''
  let lastWords = ''

  for (const event of events.toSorted((
    a,
    b,
  ) => a.seq - b.seq)) {
    const row = relevantUpdate({
      event,
      columns,
    })

    if (!row) {
      continue
    }

    const update: TaskUpdate = {
      id: row.decision?.questionId || event.id,
      at: event.at,
      seq: event.seq,
      ...row,
    }

    if (row.decision?.questionId?.startsWith('firstmate:')) {
      const key = row.decision.questionId

      if (row.decision.question && answered.delete(key)) {
        rounds.set(
          key,
          (rounds.get(key) ?? 0) + 1,
        )
      }

      if (row.decision.answer) {
        answered.add(key)
      }

      update.id = `${key}:${rounds.get(key) ?? 0}`
      update.decision = {
        ...row.decision,
        questionId: update.id,
      }
    }

    if (row.kind === 'ask') {
      update.note = withoutOwnChip({
        text: update.note,
        cardId: card.id,
      })
    }

    if (event.type === 'card.noted' && row.kind === 'ask' && event.data?.source === 'firstmate') {
      // Firstmate rewrites the whole intent when a request is added; show only what is new.
      const added = update.note.startsWith(intent)
        ? update.note.slice(intent.length).trim()
        : update.note
      intent = update.note

      if (!added) {
        continue
      }

      update.note = added
    }

    // A Firstmate move repeats the worker's last status as its reason.
    if (event.type === 'card.moved' && lastWords && update.note.endsWith(lastWords)) {
      update.note = ''
    }

    if (update.note && (row.kind === 'status' || event.type === 'card.moved')) {
      lastWords = update.note
    }

    const prior = updates.get(update.id)

    if (prior?.decision && update.decision) {
      updates.set(
        update.id,
        {
          ...prior,
          decision: mergeDecisions({
            prior: prior.decision,
            next: update.decision,
          }),
        },
      )
    } else if (!prior?.decision) {
      updates.set(
        update.id,
        update,
      )
    }
  }

  for (const declaration of card.statusLog ?? []) {
    const recorded = updates.get(declaration.id)

    if (recorded?.decision) {
      continue
    }

    updates.set(
      declaration.id,
      {
        kind: declaration.state === 'done' ? 'done' : 'status',
        ...recorded,
        ...declaration,
        // A task's first declaration shares its id with the creation event and has no note.
        ...(!declaration.note && recorded ? {
          kind: recorded.kind,
          state: recorded.state,
        } : {}),
        note: declaration.note || recorded?.note || '',
      },
    )
  }

  return closings({ updates: [...updates.values()] }).sort((
    a,
    b,
  ) =>
    b.at.localeCompare(a.at) || (b.seq ?? 0) - (a.seq ?? 0))
}

// Closing a task records a move, an outcome and a status at the same moment: one Done row.
function closings({ updates }: { updates: TaskUpdate[] }): TaskUpdate[] {
  const kept = new Map<string, TaskUpdate>()
  const rest: TaskUpdate[] = []

  for (const update of updates) {
    const prior = update.kind === 'done' ? kept.get(update.at) : undefined

    if (update.kind !== 'done') {
      rest.push(update)
    } else if (!prior) {
      kept.set(
        update.at,
        { ...update },
      )
    } else {
      prior.state = 'Done'
      prior.note ||= update.note
    }
  }

  return [
    ...rest,
    ...kept.values(),
  ]
}

export type UpdateGroupType = 'single' | 'workers' | 'changes' | 'moment' | 'decisions' | 'exchange'

export interface UpdateGroup {
  type: UpdateGroupType
  // Oldest first, whichever way the list reads.
  updates: TaskUpdate[]
}

const EXCHANGE_MS = 10 * 60_000

const spoken = ({ update }: { update?: TaskUpdate }) => update?.kind === 'ask' || update?.kind === 'hydra' || update?.kind === 'told'

const bookkeeping = ({ update }: { update?: TaskUpdate }) => update?.kind === 'renamed'
  || (update?.kind === 'moved' && !update.note)
  || (update?.kind === 'plain' && update.state === 'Brief updated')

// A group of one shows as its entry: only two or more related entries fold.
export function groupUpdates({ updates }: { updates: TaskUpdate[] }): UpdateGroup[] {
  const groups: UpdateGroup[] = []

  for (const update of updates) {
    const last = groups.at(-1)
    const prev = last?.updates.at(-1)

    if (update.kind === 'status') {
      if (last?.type === 'workers') {
        last.updates.push(update)
      } else {
        groups.push({
          type: 'workers',
          updates: [update],
        })
      }
    } else if (last && prev?.at === update.at && !spoken({ update }) && !spoken({ update: prev })
      && (update.kind === 'decision') === (prev.kind === 'decision') && [
      'single',
      'moment',
      'decisions',
    ].includes(last.type)) {
      last.updates.push(update)
      last.type = last.updates.every(item => item.kind === 'decision') ? 'decisions' : 'moment'
    } else if ((update.kind === 'hydra' || update.kind === 'told') && last?.type === 'single' && prev?.kind === 'ask'
      && Date.parse(update.at) - Date.parse(prev.at) <= EXCHANGE_MS) {
      last.type = 'exchange'
      last.updates.push(update)
    } else if (bookkeeping({ update }) && (last?.type === 'changes' || (last?.type === 'single' && bookkeeping({ update: prev })))) {
      last.type = 'changes'
      last.updates.push(update)
    } else {
      groups.push({
        type: 'single',
        updates: [update],
      })
    }
  }

  return groups.map(group => group.updates.length === 1 ? {
    type: 'single',
    updates: group.updates,
  } : group)
}
