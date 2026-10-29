import { TASK_STATES, type TaskDeclaration, type TaskStatus } from './model.ts'
import type { HydraState, Decision } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { requireReportReview } from '#investigations/inventory.ts'
import { ownerGates } from './owner-gates.ts'

// A declared state as shown to people and Hydra: a paused wait names its end, a hold says it has none.
export function declaredState({ declaration }: { declaration: Pick<TaskDeclaration, 'state' | 'until' | 'hold'> }): string {
  if (declaration.until) {
    return `${declaration.state} until ${declaration.until}`
  }

  if (declaration.hold) {
    return `${declaration.state} on hold`
  }

  return declaration.state
}

export function declareTask({
  state,
  ref,
  status,
  note,
  meta,
  source,
  raw,
  until,
  waitingFor,
  restores,
  hold,
}: {
  state: HydraState
  ref: string
  status: string
  note: string
  meta: Meta
  source?: string
  raw?: string
  until?: string
  waitingFor?: string[]
  restores?: string
  hold?: boolean
}): Decision {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card || card.automaticTask || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
    })
  }

  if (status === 'done') {
    requireReportReview({
      state,
      card,
    })
  }

  const normalized = status === 'needs-you' || status === 'needs you' ? 'needs_you' : status

  if (!(TASK_STATES as readonly string[]).includes(normalized)) {
    throw new HydraError({
      message: `use ${TASK_STATES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (until !== undefined && normalized !== 'paused') {
    throw new HydraError({
      message: '--until goes only with paused',
      field: 'until',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && normalized !== 'paused') {
    throw new HydraError({
      message: '--hold goes only with paused',
      field: 'hold',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && until !== undefined) {
    throw new HydraError({
      message: 'a hold has no end; use --hold or --until, not both',
      field: 'hold',
      code: 'VALIDATION_ERROR',
    })
  }

  const data: Omit<TaskDeclaration, 'id' | 'at' | 'actor'> = {
    state: normalized as TaskStatus,
    note,
  }

  if (normalized === 'needs_you' || normalized === 'blocked') {
    const gates = waitingFor ?? ownerGates({ card })

    if (gates.length || waitingFor) {
      data.waitingFor = gates
    }
  }

  if (restores) {
    data.restores = restores
  }

  if (source) {
    data.source = source
  }

  if (raw) {
    data.raw = raw
  }

  if (until) {
    data.until = until
  }

  if (hold) {
    data.hold = true
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.declared',
      data,
    },
  })
}
