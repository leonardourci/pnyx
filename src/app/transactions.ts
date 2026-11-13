import { EVENT_VERSION, type EventBase } from '#store/events.ts'
import type { HydraEvent } from './model.ts'
import type { Output } from './cli-support.ts'
import { HydraError } from '#store/errors.ts'
import { query, type Statement } from '#store/postgres.ts'

export type ApplyRecordedEvent = EventBase & {
  type: 'apply.recorded'
  data: { digest: string }
}

// An applied plan as earlier logs recorded it: its events and receipt on one line.
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
  eventIds,
}: {
  hydraId: string
  id: string
  digest: string
  // The Hydra's known event ids: an id it lacks was never used, so nothing need be read.
  eventIds?: Record<string, unknown>
}): Output | undefined {
  if (eventIds && !Object.hasOwn(
    eventIds,
    id,
  )) {
    return undefined
  }

  const [
    individual,
    recorded,
  ] = query({
    statements: [
      {
        text: `select 1 from events where hydra_id = $1 and id = $2
          and not (type = 'apply.recorded' and data->>'transaction' = $2)`,
        values: [
          hydraId,
          id,
        ],
      },
      {
        text: 'select digest, receipt from transactions where hydra_id = $1 and id = $2',
        values: [
          hydraId,
          id,
        ],
      },
    ],
  }) as [unknown[], {
    digest: string
    receipt: Output
  }[]]

  if (individual.length) {
    throw new HydraError({
      message: `event id ${id} already belongs to an individual event`,
      code: 'IDEMPOTENCY_CONFLICT',
    })
  }

  const transaction = recorded[0]

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

export const transactionStatement = ({
  hydraId,
  id,
  digest,
  receipt,
}: {
  hydraId: string
  id: string
  digest: string
  receipt: Output
}): Statement => ({
  text: 'insert into transactions (hydra_id, id, digest, receipt) values ($1, $2, $3, $4)',
  values: [
    hydraId,
    id,
    digest,
    JSON.stringify(receipt),
  ],
})
