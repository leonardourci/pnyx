import { requestId } from '#workers/answers.ts'
import type { Card } from './model.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'

export function ownerGates({ card }: { card: Card }): string[] {
  return [
    ...card.attention.filter(a => a.key !== INTERRUPTED && a.blocking && !a.answered)
      .map(a => `attention:${requestId({ request: a })}`),
    ...(card.permissions ?? []).filter(p => p.status === 'pending').map(p => `permission:${p.id}`),
    ...(card.asks ?? []).filter(a => a.audience === 'owner' && !a.answered && !a.closed).map(a => `ask:${a.id}`),
  ]
}
