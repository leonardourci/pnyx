import type { HydraEvent, HydraState } from '../core/model.ts'

export interface HelperBatch {
  id: string
  tasks: string[]
  prompt: string
  seqs: number[]
  once?: string[]
  error?: string
}

export interface HelperOutcome {
  task: string
  audience: 'routine' | 'owner'
  summary: string
}

export type HelperChange = {
  type: 'hydra.helper-started'
  data: HelperBatch
} | {
  type: 'hydra.helper-finished'
  data: {
    batch: string
    outcomes: HelperOutcome[]
    error?: string
  }
} | {
  type: 'hydra.helper-acknowledged'
  data: {
    batches: string[]
    through: number
  }
}

export interface HelperState {
  runs: Record<string, HelperBatch>
  outcomes: (HelperOutcome & { seq: number })[]
  handled: number[]
  wakes: string[]
  delivered: number
}

export function applyHelper({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'hydra.helper-started' && event.type !== 'hydra.helper-finished'
    && event.type !== 'hydra.helper-acknowledged') {
    return false
  }

  state.helper ??= {
    runs: {},
    outcomes: [],
    handled: [],
    wakes: [],
    delivered: 0,
  }
  const helper = state.helper

  if (event.type === 'hydra.helper-started') {
    helper.runs[event.data.id] = structuredClone(event.data)
  } else if (event.type === 'hydra.helper-finished') {
    const batch = helper.runs[event.data.batch]
    helper.handled.push(...batch?.seqs ?? [])
    helper.wakes.push(...batch?.once ?? [])

    if (batch && event.data.error) {
      batch.error = event.data.error
    } else {
      delete helper.runs[event.data.batch]
    }

    helper.outcomes.push(...event.data.outcomes.map(outcome => ({
      ...outcome,
      seq: event.seq,
    })))
  } else {
    for (const batch of event.data.batches) {
      delete helper.runs[batch]
    }

    helper.delivered = Math.max(
      helper.delivered,
      event.data.through,
    )
  }

  return true
}

export const handbackId = ({ id }: { id: string }) => `helper-handback:${id}`

export function outcomeLines({ state }: { state: HydraState }): string[] {
  return (state.helper?.outcomes ?? [])
    .filter(outcome => outcome.audience === 'owner' && outcome.seq > (state.helper?.delivered ?? 0))
    .map(outcome => `- ${outcome.task}: ${outcome.summary}`)
}

export const wakeHandled = ({
  state,
  id,
}: {
  state: HydraState
  id: string
}) =>
  `${id}:hosted` in state.eventIds || (state.helper?.wakes ?? []).includes(id)
