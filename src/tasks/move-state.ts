import { touch } from './touch.ts'
import type { EventBase } from '#store/events.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { AgentSession } from '#workers/model.ts'
import type { Card } from './model.ts'
import type { Column } from './columns-model.ts'
import { refreshTasks } from './columns.ts'

// Both sides carry the whole card and its sessions so either log replays alone; they share the event id.
export interface MovedCard {
  moving?: {
    tasks: string[]
    sessions: string[]
  }
  card: Card
  sessions: AgentSession[]
}

export type HydraMoveEvent = EventBase & (
  | {
    type: 'task.moved-out'
    data: MovedCard & { to: string }
  }
  | {
    type: 'task.moved-in'
    data: MovedCard & {
      from: string
      column: Column
      // When each of the card's owner questions was last reminded, so the target does not remind them again at once.
      reminders?: Record<string, string>
    }
  }
)

// What the source keeps of a card it handed on, so a lookup there names the Hydra it went to.
export interface MovedOut {
  to: string
  at: string
  move: string
  key: string
}

// The card a reference named before it moved away, by id or key.
export function movedAway({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): (MovedOut & { id: string }) | undefined {
  const found = Object.entries(state.movedOut ?? {}).find(([
    id,
    moved,
  ]) => id === ref || moved.key === ref)

  return found && {
    ...found[1],
    id: found[0],
  }
}

function moveOut({
  state,
  event,
}: {
  state: HydraState
  event: Extract<HydraMoveEvent, { type: 'task.moved-out' }>
}): void {
  const card = state.cards[event.cardId]

  if (!card) {
    return
  }

  const departingIdsInCommand = event.data.moving?.tasks ?? [card.id]
  const departing = departingIdsInCommand.flatMap(id => state.cards[id] ? [state.cards[id]] : [])
  const departingIds = new Set(departing.map(item => item.id))

  for (const related of Object.values(state.cards)) {
    if (departingIds.has(related.id)) {
      continue
    }

    const affected = departing.filter(item => related.parentId === item.id
      || related.prerequisites?.includes(item.id)
      || related.wait?.task === item.id
      || (related.queue && item.sessionIds?.includes(related.queue.session)))

    if (!affected.length) {
      continue
    }

    if (related.parentId && departingIds.has(related.parentId)) {
      delete related.parentId
    }

    related.prerequisites = related.prerequisites?.filter(id => !departingIds.has(id))

    if (related.wait && departingIds.has(related.wait.task)) {
      delete related.wait
    }

    if (related.queue && departing.some(item => item.sessionIds?.includes(related.queue?.session ?? ''))) {
      delete related.queue
    }

    related.notices = affected.map(item => ({
      task: related.id,
      reason: `Local relationship to ${item.id} cleared when it moved to Hydra ${event.data.to}`,
      clear: `Use pnyx task move ${item.id} --to-hydra ${event.boardId ?? '<source-hydra>'} --hydra ${event.data.to}, then task parent, task depend, or task queue to restore the relationship`,
    }))
    touch({
      card: related,
      event,
    })
  }

  delete state.cards[card.id]

  for (const [
    key,
    id,
  ] of Object.entries(state.keys)) {
    if (id === card.id) {
      delete state.keys[key]
    }
  }

  for (const session of card.sessionIds ?? []) {
    delete state.sessions?.[session]
  }

  state.movedOut = {
    ...state.movedOut,
    [card.id]: {
      to: event.data.to,
      at: event.at,
      move: event.id,
      key: card.key,
    },
  }
}

// The card starts a new attachment here: its session's next turn resumes under this Hydra.
function moveIn({
  state,
  event,
}: {
  state: HydraState
  event: Extract<HydraMoveEvent, { type: 'task.moved-in' }>
}): void {
  const card = structuredClone(event.data.card)
  Reflect.deleteProperty(
    card,
    'kind',
  )
  Reflect.deleteProperty(
    card,
    'report',
  )

  for (const ask of card.asks ?? []) {
    Reflect.deleteProperty(
      ask,
      'origin',
    )
  }

  const arriving = new Set(event.data.moving?.tasks ?? [])

  if (card.parentId && !state.cards[card.parentId]
    && !arriving.has(card.parentId)) {
    delete card.parentId
  }

  if (card.prerequisites) {
    card.prerequisites = card.prerequisites.filter(id => state.cards[id] || arriving.has(id))
  }

  if (card.wait && !state.cards[card.wait.task]
    && !arriving.has(card.wait.task)) {
    delete card.wait
  }

  if (card.queue && !state.sessions?.[card.queue.session]
    && !event.data.moving?.sessions.includes(card.queue.session)) {
    delete card.queue
  }

  card.column = event.data.column
  delete card.rank
  card.createdSeq = event.seq
  card.steeringGeneration = event.seq
  // An arrival that replaces a cut move's copy keeps the revision rising, so --if-revision stays meaningful.
  card.revision = Math.max(
    card.revision,
    state.cards[card.id]?.revision ?? 0,
  ) + 1
  card.updatedSeq = event.seq
  card.updatedAt = event.at
  state.cards[card.id] = card
  state.keys[card.key] = card.id
  delete state.movedOut?.[card.id]
  state.questionReminders = {
    ...state.questionReminders,
    ...event.data.reminders,
  }

  const attached = new Set(card.sessionIds ?? [])
  const sessions = state.sessions ?? {}
  state.sessions = sessions

  for (const session of event.data.sessions) {
    if (attached.has(session.id)) {
      sessions[session.id] = {
        ...structuredClone(session),
        taskId: card.id,
        originCardId: card.id,
      }
    } else if (!sessions[session.id]) {
      sessions[session.id] = {
        ...structuredClone(session),
        taskId: null,
        originCardId: card.id,
      }
    }
  }

  refreshTasks({
    state,
    ids: [card.id],
  })
}

export function applyHydraMove({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type === 'task.moved-out') {
    moveOut({
      state,
      event,
    })

    return true
  }

  if (event.type === 'task.moved-in') {
    moveIn({
      state,
      event,
    })

    return true
  }

  return false
}
