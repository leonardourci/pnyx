import { hydraConfig } from './config.ts'
import { TITAN_CARD } from './identity.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { isRoutineMessage, type TitanMessage } from './model.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { ownerActor } from '#app/actors.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { hydraInputDispatched } from './received.ts'

const STARTED_RECEIPTS = 32

// Messages sent to this Titan after an operation began holding them, that no turn has taken and Stop has not cancelled.
function heldMessages({ state }: { state: TitanState }) {
  const stopSeq = state.hydraOperation?.seq

  if (stopSeq === undefined) {
    return []
  }

  const hydra = hydraConfig({ state }).hydra.id
  const sentSince = ({ message }: { message: TitanMessage }) =>
    (state.eventIds[message.id] ?? 0) > stopSeq

  return (state.hydraMessages ?? []).filter(message => message.hydra === hydra
    && !isRoutineMessage({ message }) && !message.stopped && !message.failure
    && sentSince({ message }) && !hydraInputDispatched({
    state,
    message,
  }))
}

function hydraQueueView({
  state,
  card,
}: {
  state: TitanState
  card?: Card
}) {
  const compacting = activeCompaction({ card })
  const upgrades = state.upgrades ?? []
  const stopped = state.hydraOperation
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
  const holding = Boolean(compacting) || upgrading || Boolean(stopped)
  const upgradeRunning = upgrades.some(operation => operation.state === 'running')

  const cancelled = new Set(state.hydraMessages?.filter(message => message.stopped)
    .map(message => message.id))
  const compactInputs = [
    ...(card?.compaction?.inputs.filter(input => ownerActor({ actor: input.actor })
      && !cancelled.has(input.id)) ?? []),
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
    upgradeRunning,
    compactInputs: inputs,
  }
}

// Othrys is running a turn of this Titan's agent now.
export function hydraWorking({ state }: { state: TitanState }) {
  const card = state.cards[TITAN_CARD]

  return (card?.sessionActivity ?? card?.activity) === 'working'
}

export function hydraChatQueue({ state }: { state: TitanState }) {
  const config = hydraConfig({ state })
  const card = state.cards[TITAN_CARD]
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

    if (ownerActor({ actor: message.actor }) && hydraInputDispatched({
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

export type TitanChatQueue = ReturnType<typeof hydraChatQueue>
