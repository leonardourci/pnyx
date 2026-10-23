import type { Card } from '../../../src/core/model.ts'
import { relevantUpdate, type TaskEvent, type TaskUpdate, type UpdateColumns, type UpdateDecision } from '../../../src/core/updates.ts'
import { mentionId, TASK_MENTION } from '../../../src/mentions/mentions.ts'

const OWN_CHIP = new RegExp(`^${TASK_MENTION.source}\\s*`)

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
  columns: UpdateColumns
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

const spoken = ({ update }: { update?: TaskUpdate }) => update?.kind === 'ask' || update?.kind === 'hydra' || update?.kind === 'told' || update?.kind === 'report'

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
