import { liveTask } from '../tasks/select.ts'
import { interactive } from '../core/tasks.ts'
import type { HydraEvent, HydraState } from '../app/model.ts'
import type { Card } from '../tasks/model.ts'
import type { AgentSession } from '../core/model.ts'

export const QUEUE_STALL_MS = 30 * 60 * 1000
export const QUEUE_MAX_TASKS = 3
export const QUEUE_CONTEXT_BYTES = 2 * 1024 * 1024
export const QUEUE_POLL_MS = 30_000

export function queueWorker({
  state,
  session,
}: {
  state: HydraState
  session: AgentSession
}): Card | undefined {
  const card = session.taskId ? state.cards[session.taskId] : undefined

  return card && liveTask({ card }) && interactive({ session })
    && session.id !== state.config?.hydra.session && session.activity !== 'ended'
    && session.sessionActivity !== 'ended' ? card : undefined
}

export function workerQueue({
  state,
  session,
}: {
  state: HydraState
  session: string
}): Card[] {
  return Object.values(state.cards).filter(c => c.queue?.session === session)
    .sort((
      a,
      b,
    ) => a.queue!.rank - b.queue!.rank || a.id.localeCompare(b.id))
}

export function queuePosition({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  return card.queue ? {
    session: card.queue.session,
    position: workerQueue({
      state,
      session: card.queue.session,
    }).findIndex(c => c.id === card.id) + 1,
  } : undefined
}

export function applyQueue({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'task.queue') {
    return false
  }

  const card = state.cards[event.cardId]

  if (card) {
    if (event.data.after) {
      card.queue = { ...event.data.after }
      delete card.queueNote
    } else {
      delete card.queue

      if (event.data.note) {
        card.queueNote = event.data.note
      }
    }

    for (const [
      index,
      id,
    ] of (event.data.order ?? []).entries()) {
      const queued = state.cards[id]

      if (queued?.queue?.session === event.data.after?.session && queued?.queue
        && queued.queue.rank !== index + 1) {
        queued.queue.rank = index + 1

        if (queued.id !== card.id) {
          queued.revision++
          queued.updatedSeq = event.seq
          queued.updatedAt = event.at
        }
      }
    }

    card.column = event.data.column
    card.revision++
    card.updatedSeq = event.seq
    card.updatedAt = event.at
  }

  return true
}
