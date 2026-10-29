import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { HydraError } from '#store/errors.ts'
import { OUTCOME_STATES, type Outcome } from './model.ts'
import { parseLink, decideLink } from './links.ts'
import { decideOutcome } from './outcome.ts'

export type DeliveryOperation = {
  task: string
  reason?: string
} & (
  | {
    op: 'link'
    url: string
    kind?: string
    number?: string
    title?: string
    state?: string
    remove?: boolean
  }
  | {
    op: 'outcome'
    state?: string
    note?: string
    clear?: boolean
  }
)

export function planDeliveryChange({
  state,
  operation,
  meta,
}: {
  state: HydraState
  operation: DeliveryOperation
  meta: Meta
}) {
  if (operation.op === 'link') {
    const metadata = [
      operation.kind,
      operation.number,
      operation.title,
      operation.state,
    ]

    if (operation.remove && metadata.some(value => value !== undefined)) {
      throw new HydraError({
        message: 'remove cannot also set link fields',
        field: 'remove',
        code: 'VALIDATION_ERROR',
      })
    }

    const link = operation.remove ? null : parseLink({
      input: {
        url: operation.url,
        kind: operation.kind,
        number: operation.number,
        title: operation.title,
        state: operation.state,
        checkedAt: operation.state ? meta.at : undefined,
      },
    })

    return decideLink({
      state,
      ref: operation.task,
      url: operation.url,
      link,
      meta,
    })
  }

  if (Boolean(operation.clear) === (operation.state !== undefined)) {
    throw new HydraError({
      message: 'give either an outcome or clear',
      code: 'VALIDATION_ERROR',
    })
  }

  if (operation.clear && operation.note !== undefined) {
    throw new HydraError({
      message: 'clear cannot also set an outcome note',
      field: 'note',
      code: 'VALIDATION_ERROR',
    })
  }

  const validState = operation.state === undefined
    || (OUTCOME_STATES as readonly string[]).includes(operation.state)

  if (!validState) {
    throw new HydraError({
      message: `state must be one of ${OUTCOME_STATES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  let outcome: Outcome | null = null

  if (operation.state !== undefined) {
    outcome = { state: operation.state as Outcome['state'] }

    if (operation.note) {
      outcome.note = operation.note
    }
  }

  return decideOutcome({
    state,
    ref: operation.task,
    outcome,
    meta,
  })
}
