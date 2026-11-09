import type { EventBase } from '#store/events.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { AgentSession } from '#workers/model.ts'
import type { Card } from './model.ts'
import type { Column } from './columns-model.ts'
import { refreshTasks } from './columns.ts'

// The card's whole record and every session it had, so either Hydra's log replays on its own.
// Both sides of one move share the event id, which is how history finds the other side.
export interface MovedCard {
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
    }
  }
)

// What the source keeps of a card it handed on, so a lookup there names the Hydra it went to.
export interface MovedOut {
  to: string
  at: string
  move: string
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
  card.column = event.data.column
  delete card.rank
  card.createdSeq = event.seq
  card.steeringGeneration = event.seq
  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at
  state.cards[card.id] = card
  state.keys[card.key] = card.id
  delete state.movedOut?.[card.id]

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
