import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { base, type Meta } from '#app/command-meta.ts'
import { withWriter } from '#app/writer.ts'
import { askHost } from '#app/server-state.ts'
import { findCard } from './push-rules.ts'
import { rightsDigest, rightsScope } from './rights.ts'
import type { RightsChange } from './rights-model.ts'
import { HydraError } from '#store/errors.ts'

export function requestRights({
  hydraId,
  task,
  value,
  reason,
  meta,
}: {
  hydraId: string
  task: string
  value: unknown
  reason: string
  meta: Meta
}) {
  const scope = rightsScope({ value })

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = findCard({
        state: writer.state,
        ref: task,
      })
      const change: RightsChange = {
        type: 'task.rights-requested',
        data: {
          request: randomUUID(),
          revision: (card.rights?.revision ?? 0) + 1,
          scope,
          reason,
        },
      }
      writer.append({
        event: {
          ...base({
            state: writer.state,
            meta,
            cardId: card.id,
          }),
          ...change,
        },
      })

      return { rights: writer.state.cards[card.id]?.rights }
    },
  })
}

// Called only after authentication on the owner listener; the agent broker never exposes this action.
export function ownerRights({
  hydraId,
  task,
  action,
  request,
  revision,
  digest,
  reason,
}: {
  hydraId: string
  task: string
  action: 'confirm' | 'revoke'
  request: string
  revision: number
  digest: string
  reason?: string
}) {
  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = findCard({
        state: writer.state,
        ref: task,
      })
      const rights = card.rights

      if (!rights || rights.requested.id !== request || rights.revision !== revision
      || rightsDigest({ scope: rights.requested.scope }) !== digest) {
        throw new HydraError({
          code: 'STALE_RIGHTS',
          message: 'Review the current exact rights request before confirming it',
        })
      }

      let change: RightsChange

      if (action === 'confirm') {
        if (rights.revoked || rights.granted?.request === request) {
          throw new HydraError({
            code: 'STALE_RIGHTS',
            message: 'This rights confirmation was already consumed; request a new revision',
          })
        }

        change = {
          type: 'task.rights-granted',
          data: {
            request,
            revision,
            grant: randomUUID(),
            scope: rights.requested.scope,
          },
        }
      } else {
        if (!rights.granted || rights.revoked) {
          throw new HydraError({
            code: 'STALE_RIGHTS',
            message: 'There is no current grant to revoke',
          })
        }

        change = {
          type: 'task.rights-revoked',
          data: {
            grant: rights.granted.id,
            revision,
            reason: reason ?? 'Revoked by owner',
          },
        }
      }

      writer.append({
        event: {
          ...base({
            state: writer.state,
            meta: {
              actor: 'owner',
              at: new Date().toISOString(),
            },
            cardId: card.id,
          }),
          ...change,
        },
      })

      return { rights: writer.state.cards[card.id]?.rights }
    },
  })
}

export async function rightsCommand({
  args,
  hydraId,
  task,
  file,
  reason,
  meta,
}: {
  args: string[]
  hydraId: string
  task: string
  file?: string
  reason?: string
  meta: Meta
}) {
  if (args[0] === 'request' && file) {
    return requestRights({
      hydraId,
      task,
      value: JSON.parse(readFileSync(
        file,
        'utf8',
      )),
      reason: reason ?? '',
      meta,
    })
  }

  if (args[0] !== 'confirm' && args[0] !== 'revoke') {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: 'Use task rights <task> request --file scope.json, or confirm|revoke <request> <revision> <digest>',
    })
  }

  return askHost({
    hydraId,
    body: {
      action: 'rights',
      task,
      operation: args[0],
      request: args[1],
      revision: Number(args[2]),
      digest: args[3],
      reason,
    },
  })
}
