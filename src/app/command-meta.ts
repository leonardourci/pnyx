import type { HydraState, HydraEvent } from './model.ts'
import { EVENT_VERSION } from '../store/events.ts'
import { freeId } from '../core/decide.ts'

export interface Meta {
  at: string
  actor: string
  // Caller-chosen event id; repeating it is a no-op.
  id?: string
  // Expected card revision; 0 for a card that does not exist yet.
  ifRevision?: number
  reason?: string
  details?: string
}

export function base({
  state,
  meta,
  cardId,
}: {
  state: HydraState
  meta: Meta
  cardId: string
}) {
  const seq = state.seq + 1

  const event: Pick<HydraEvent, 'v' | 'seq' | 'id' | 'at' | 'actor' | 'cardId' | 'reason' | 'details'> = {
    v: EVENT_VERSION,
    seq,
    id: meta.id ?? freeId({
      state,
      seq,
    }),
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
  }

  if (meta.details) {
    event.details = meta.details
  }

  return event
}
