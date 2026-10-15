import { EVENT_VERSION, type BoardEvent, type BoardState, type Card, type PermissionRequest } from './model.ts'
import type { Meta } from './decide.ts'

const PREFIX = 'pnyx:permission:'

export function permissionAttention({ card }: { card: Card }): void {
  card.attention = [
    ...card.attention.filter(a => !a.key.startsWith(PREFIX)),
    ...(card.permissions ?? []).filter(p => p.status === 'pending').map(p => ({
      kind: 'permission',
      key: `${PREFIX}${p.id}`,
      blocking: true,
      text: `${p.tool}: ${p.description ?? JSON.stringify(p.input)}`,
    })),
  ]
}

export function permissionEvent({ state, card, request, meta }: {
  state: BoardState
  card: Card
  request: PermissionRequest
  meta: Meta
}): Extract<BoardEvent, { type: 'task.permission' }> {
  return {
    v: EVENT_VERSION,
    seq: state.seq + 1,
    id: meta.id ?? `permission:${request.id}:${request.status}`,
    at: meta.at,
    actor: meta.actor,
    cardId: card.id,
    ...(meta.reason ? { reason: meta.reason } : {}),
    type: 'task.permission',
    data: request,
  }
}

export function applyPermission({ state, event }: {
  state: BoardState
  event: BoardEvent
}): boolean {
  if (event.type !== 'task.permission') {
    return false
  }

  const card = state.cards[event.cardId]

  if (card) {
    const requests = card.permissions ?? []
    const prior = requests.find(p => p.id === event.data.id)

    if ((!prior && event.data.status === 'pending') || (prior?.status === 'pending' && event.data.status !== 'pending' && prior.session === event.data.session)) {
      card.permissions = prior
        ? requests.map(p => p.id === prior.id ? { ...prior, status: event.data.status } : p)
        : [...requests, structuredClone(event.data)]
      permissionAttention({ card })
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }
  }

  return true
}
