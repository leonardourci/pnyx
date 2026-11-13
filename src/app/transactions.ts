import { EVENT_VERSION, type EventBase } from '#store/events.ts'
import type { HydraEvent } from './model.ts'
import type { Output } from './cli-support.ts'
import { HydraError } from '#store/errors.ts'
import { hydraDir } from './home-migration.ts'
import { readLog } from './event-log.ts'

export type ApplyRecordedEvent = EventBase & {
  type: 'apply.recorded'
  data: { digest: string }
}

export interface Transaction {
  v: typeof EVENT_VERSION
  type: 'log.transaction'
  id: string
  digest: string
  events: HydraEvent[]
  receipt: Output
}

export function transactionReceipt({
  hydraId,
  id,
  digest,
  migrate = true,
  eventIds,
}: {
  hydraId: string
  id: string
  digest: string
  migrate?: boolean
  // The Hydra's known event ids: an id it lacks was never used, so the whole log need not be read.
  eventIds?: Record<string, unknown>
}): Output | undefined {
  if (eventIds && !Object.hasOwn(
    eventIds,
    id,
  )) {
    return undefined
  }

  const log = readLog({
    dir: hydraDir({
      hydraId,
      migrate,
    }),
  })

  if (log?.events.some(event => event.id === id
    && !(event.type === 'apply.recorded' && event.transaction === id))) {
    throw new HydraError({
      message: `event id ${id} already belongs to an individual event`,
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }

  const transaction = log?.transactions.find(entry => entry.id === id)

  if (!transaction) {
    return undefined
  }

  if (transaction.digest !== digest) {
    throw new HydraError({
      message: `apply event id ${id} was already used with different contents or actor`,
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }

  return {
    ...transaction.receipt,
    duplicate: true,
  }
}
