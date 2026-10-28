import type { HydraEvent, HydraState } from '#app/model.ts'
import { taskMention } from '#hydra/mentions.ts'

export interface HelperBatch {
  id: string
  tasks: string[]
  prompt: string
  seqs: number[]
  once?: string[]
  error?: string
  startedAt?: string
}

export interface HelperOutcome {
  task: string
  audience: 'routine' | 'owner'
  summary: string
}

export interface HelperUsage {
  used?: number
  window?: number
  cost?: number
  inputTokens?: number
}

export interface HelperUsageTotal extends HelperUsage {
  batches: number
  measuredBatches: number
}

export type HelperChange = {
  type: 'hydra.helper-started'
  data: HelperBatch
} | {
  type: 'hydra.helper-finished'
  data: {
    batch: string
    outcomes: HelperOutcome[]
    usage?: HelperUsage
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
  usage?: HelperUsageTotal
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
    helper.runs[event.data.id] = {
      ...structuredClone(event.data),
      startedAt: event.at,
    }
  } else if (event.type === 'hydra.helper-finished') {
    const batch = helper.runs[event.data.batch]
    const usage = event.data.usage
    const total = helper.usage ?? {
      batches: 0,
      measuredBatches: 0,
    }
    total.batches++

    if (usage?.cost !== undefined) {
      total.cost = (total.cost ?? 0) + usage.cost
      total.measuredBatches++
    }

    if (usage?.inputTokens !== undefined) {
      total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens
    }

    if (usage?.used !== undefined) {
      total.used = usage.used
    }

    if (usage?.window !== undefined) {
      total.window = usage.window
    }

    helper.usage = total
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
    .map(outcome => `- ${taskMention({
      id: outcome.task,
      title: state.cards[outcome.task]?.title ?? outcome.task,
    })}: ${outcome.summary}`)
}

export const wakeHandled = ({
  state,
  id,
}: {
  state: HydraState
  id: string
}) =>
  `${id}:hosted` in state.eventIds || (state.helper?.wakes ?? []).includes(id)

export function activeHelperBatches({ state }: { state: HydraState }): HelperBatch[] {
  return Object.values(state.helper?.runs ?? {}).filter(batch => !batch.error)
}

export function helperLeases({ state }: { state: HydraState }): string[] {
  const batches = activeHelperBatches({ state })

  if (!batches.length) {
    return ['Active helper leases: none']
  }

  return [
    'Active helper leases (leave these tasks until the grant ends; do not retry a leased action):',
    ...batches.flatMap(batch => batch.tasks.map(task => `- ${taskMention({
      id: task,
      title: state.cards[task]?.title ?? task,
    })} held by helper:${batch.id}, started ${batch.startedAt ?? 'unknown'}`)),
  ]
}
