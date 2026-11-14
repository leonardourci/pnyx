import { hostedHydra, hydraConfig } from './config.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { isRoutineMessage, type HydraMessage } from './model.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { ownerActor } from '#app/actors.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'

const STARTED_RECEIPTS = 32

// A message whose Hydra turn started has been taken.
const taken = ({
  state,
  message,
}: {
  state: HydraState
  message: HydraMessage
}) => `${message.id}:hosted` in state.eventIds

// What was sent to this Hydra since an operation or an agent change stopped it, that no Hydra turn has taken.
export function heldMessages({ state }: { state: HydraState }) {
  const change = state.hydraAgentChange
  const changeSeq = change ? (state.eventIds[change.id] ?? 1) - 1 : undefined
  const stopSeq = state.hydraOperation?.seq ?? changeSeq

  if (stopSeq === undefined) {
    return []
  }

  const hydra = hydraConfig({ state }).hydra.id

  return (state.hydraMessages ?? []).filter(message => message.hydra === hydra
    && !isRoutineMessage({ message }) && !message.stopped
    && (state.eventIds[message.id] ?? 0) > stopSeq && !taken({
    state,
    message,
  }))
}

function hydraQueueView({
  state,
  card,
}: {
  state: HydraState
  card?: Card
}) {
  const compacting = activeCompaction({ card })
  const upgrades = state.upgrades ?? []
  const stopped = state.hydraOperation
  const changingAgent = state.hydraAgentChange
  // While an operation stops Hydra, what was sent to it since waits in the queue box until Hydra's next turn takes it.
  const waiting = heldMessages({ state })
  const held = new Set([
    ...card?.compaction?.inputs.map(input => input.id) ?? [],
    ...waiting.map(message => message.id),
  ])
  const compactOperations = card?.compaction?.operations ?? []
  // Only the newest result shows; a new attempt replaces the last one.
  const shownUpgrades = upgrades.filter(operation => operation.state !== 'queued')
    .sort((
      a,
      b,
    ) => a.queuedAt.localeCompare(b.queuedAt))
    .slice(-1)
  const upgrading = upgrades.some(operation => operation.state === 'running' || operation.state === 'restarting')
  const holding = Boolean(compacting) || upgrading || Boolean(stopped) || Boolean(changingAgent)
  const runningChange = changingAgent?.state === 'running'
  const compactionRunning = Boolean(compacting) || runningChange
  const upgradeRunning = upgrades.some(operation => operation.state === 'running')

  // A queued /upgrade waits in the same box, with the same Send now.
  const compactInputs = [
    ...(card?.compaction?.inputs.filter(input => ownerActor({ actor: input.actor })) ?? []),
    ...upgrades.filter(operation => operation.state === 'queued').map(operation => ({
      id: operation.id,
      text: UPGRADE_COMMAND,
      actor: 'web',
      route: 'hydra' as const,
      at: operation.queuedAt,
    })),
    ...waiting.filter(message => ownerActor({ actor: message.actor })).map(message => ({
      id: message.id,
      text: message.text,
      actor: message.actor,
      at: message.at,
      route: 'hydra' as const,
    })),

  ]

  const seen = new Set<string>()
  const inputs = compactInputs.filter(input => {
    if (seen.has(input.id)) {
      return false
    }

    seen.add(input.id)

    return true
  })

  return {
    compacting,
    upgrades,
    held,
    compactOperations,
    shownUpgrades,
    upgrading,
    holding,
    runningChange,
    compactionRunning,
    upgradeRunning,
    compactInputs: inputs,
  }
}

// Pnyx is running a turn of this Hydra's agent now.
export function hydraWorking({ state }: { state: HydraState }) {
  const card = state.cards[HYDRA_CARD]

  return hostedHydra({ state }) && (card?.sessionActivity ?? card?.activity) === 'working'
}

export function hydraChatQueue({ state }: { state: HydraState }) {
  const config = hydraConfig({ state })
  const card = state.cards[HYDRA_CARD]
  const messages = (state.hydraMessages ?? []).filter(message => message.hydra === config.hydra.id)
  const working = hydraWorking({ state })
  const view = hydraQueueView({
    state,
    card,
  })

  const started: string[] = []

  let index = messages.length - 1

  // Newest first, stopping at the receipts the page keeps.
  while (index >= 0 && started.length < STARTED_RECEIPTS) {
    const message = messages[index]!

    if (ownerActor({ actor: message.actor }) && taken({
      state,
      message,
    })) {
      started.unshift(message.id)
    }

    index -= 1
  }

  return {
    ...view,
    held: [...view.held],
    working,
    through: state.seq,
    started,
  }
}

export type HydraChatQueue = ReturnType<typeof hydraChatQueue>
