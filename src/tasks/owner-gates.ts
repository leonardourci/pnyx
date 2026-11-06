import { requestId } from '#workers/answers.ts'
import type { Card } from './model.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { pendingPermissions } from '#workers/permission-rules.ts'

export function ownerGates({ card }: { card: Card }): string[] {
  return [
    ...card.attention.filter(a => a.key !== INTERRUPTED && a.blocking && !a.answered)
      .map(a => `attention:${requestId({ request: a })}`),
    ...pendingPermissions({ card }).map(p => `permission:${p.id}`),
    ...(card.asks ?? []).filter(a => a.audience === 'owner' && !a.answered && !a.closed).map(a => `ask:${a.id}`),
  ]
}
