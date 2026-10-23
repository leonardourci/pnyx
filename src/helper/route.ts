import { ownerGates } from '../core/gates.ts'
import { openAsks } from '../core/asks.ts'
import { openDecisions } from '../core/decisions.ts'
import { HYDRA_CARD, hydraConfig } from '../core/hydra.ts'
import { reportActor } from '../core/hydra.ts'
import type { AgentConfig, HydraEvent, HydraState } from '../core/model.ts'
import type { WakeKind } from '../core/wake-reasons.ts'

const ROUTINE_KINDS: WakeKind[] = [
  'asked',
  'turn ended',
  'quiet',
  'wait ended',
  'not confirmed',
]

export function helperAgent({
  state,
  main,
}: {
  state: HydraState
  main?: AgentConfig
}): AgentConfig | undefined {
  const config = hydraConfig({ state })

  if (config.helper === false || config.hydra.kind !== 'agent') {
    return undefined
  }

  if (config.helper) {
    return config.helper
  }

  const harness = config.hydra.agent?.harness ?? main?.harness ?? 'claude'

  return {
    harness,
    model: harness === 'claude' ? 'sonnet' : 'gpt-6-luna',
  }
}

export function helperTask({
  state,
  task,
}: {
  state: HydraState
  task: string
}): boolean {
  const card = state.cards[task]

  if (!card || card.id === HYDRA_CARD || card.automaticTask || card.hold) {
    return false
  }

  const ownerDecision = openDecisions({ state }).some(item => item.card.id === task
    && item.kind !== 'worker question')
  const ownerAsk = openAsks({ card }).some(ask => ask.audience === 'owner' || ask.escalated)

  return !ownerDecision && !ownerAsk && !ownerGates({ card }).length
}

export function helperReason({
  state,
  task,
  kind,
}: {
  state: HydraState
  task: string
  kind: WakeKind
}): boolean {
  return ROUTINE_KINDS.includes(kind) && helperTask({
    state,
    task,
  })
}

export function helperEvent({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): string | undefined {
  const task = event.type === 'hydra.message' ? event.data.task : event.cardId

  if (!task || !helperTask({
    state,
    task,
  })) {
    return undefined
  }

  if (event.type === 'hydra.message') {
    if (reportActor({ actor: event.actor }) && (event.data.kind === 'progress' || event.data.ask)) {
      return task
    }
  } else if (event.type === 'task.declared') {
    if (event.data.state === 'blocked' || event.data.state === 'needs_you') {
      return task
    }
  } else if (event.type === 'card.pushed') {
    if (!state.cards[task]?.links.some(link => link.kind === 'github_pr' && link.state === 'open')) {
      return task
    }
  }

  return undefined
}

export function helperGrant({
  state,
  task,
  actor,
}: {
  state: HydraState
  task: string
  actor: string
}): boolean {
  const batch = state.helper?.runs[actor.slice('helper:'.length)]

  return actor.startsWith('helper:') && !!batch && !batch.error && batch.tasks.includes(task)
    && helperTask({
      state,
      task,
    })
}

export function helperProgress({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): string | undefined {
  if (event.type === 'hydra.message' && event.data.kind === 'progress' && helperAgent({ state })) {
    return helperEvent({
      state,
      event,
    })
  }

  return undefined
}
