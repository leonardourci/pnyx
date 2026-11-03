import type { Decision, HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraEvent } from './hydra.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraOperation } from './model.ts'
import { outageMinutes, recapText } from './wakes.ts'
import { operationLabel } from './operation-label.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'

export { operationLabel } from './operation-label.ts'

export function operationEvent({
  state,
  operation,
  meta,
}: {
  state: HydraState
  operation: HydraOperation
  meta: Meta
}): Decision {
  return hydraEvent({
    state,
    cardId: HYDRA_CARD,
    meta: {
      ...meta,
      id: `operation:${operation.id}:${operation.state}`,
    },
    change: {
      type: 'hydra.operation',
      data: operation,
    },
  })
}

// Whether anything addressed to Hydra was recorded since the stop began.
export const arrivedSince = ({
  state,
  after,
}: {
  state: HydraState
  after: number
}) => (state.hydraMessages ?? []).some(message => (state.eventIds[message.id] ?? 0) > after
  && message.actor !== HYDRA_ACTOR && message.kind !== 'progress' && message.kind !== 'divider')

// Hydra's first turn after an operation stopped it: what it was, how it ended and what the owner wrote meanwhile.
export function operationRecap({
  state,
  operation,
  error,
  now,
}: {
  state: HydraState
  operation: NonNullable<HydraState['hydraOperation']>
  error?: string
  now: number
}): string {
  const minutes = outageMinutes({
    since: operation.since,
    now,
  })
  const label = operationLabel({
    kind: operation.kind,
    state: error ? 'failed' : 'finished',
  })

  return recapText({
    state,
    since: operation.since,
    after: operation.seq,
    now,
    why: `Why you are woken: back after a stop (${label}${error ? `: ${error}` : ''}). Everything addressed to you waited from ${operation.since} until now (${minutes} min).`,
  })
}
