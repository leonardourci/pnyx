import { titanConfig } from './config.ts'
import { TITAN_CARD } from './identity.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { isRoutineMessage, type TitanMessage } from './model.ts'
import { activeCompaction } from '#workers/compaction/state.ts'
import { ownerActor } from '#app/actors.ts'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { titanInputDispatched } from './received.ts'

const STARTED_RECEIPTS = 32

export function undeliveredMessagesSince({
  state,
  after,
}: {
  state: TitanState
  after: number
}) {
  const titan = titanConfig({ state }).titan.id
  const sentSince = ({ message }: { message: TitanMessage }) =>
    (state.eventIds[message.id] ?? 0) > after

  return (state.titanMessages ?? []).filter(message => message.titan === titan
    && !isRoutineMessage({ message }) && !message.stopped && !message.failure
    && sentSince({ message }) && !titanInputDispatched({
    state,
    message,
  }))
}

function heldMessages({ state }: { state: TitanState }) {
  const operation = state.titanOperation

  if (!operation) {
    return []
  }

  return undeliveredMessagesSince({
    state,
    after: operation.seq,
  })
}

function titanQueueView({
  state,
  card,
}: {
  state: TitanState
  card?: Card
}) {
  const compacting = activeCompaction({ card })
  const upgrades = state.upgrades ?? []
  const stopped = state.titanOperation
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

  const cancelled = new Set(state.titanMessages?.filter(message => message.stopped)
    .map(message => message.id))
  const compactInputs = [
    ...(card?.compaction?.inputs.filter(input => ownerActor({ actor: input.actor })
      && !cancelled.has(input.id)) ?? []),
    ...upgrades.filter(operation => operation.state === 'queued').map(operation => ({
      id: operation.id,
      text: UPGRADE_COMMAND,
      actor: 'web',
      route: 'titan' as const,
      at: operation.queuedAt,
    })),
    ...waiting.filter(message => ownerActor({ actor: message.actor })).map(message => ({
      id: message.id,
      text: message.text,
      actor: message.actor,
      at: message.at,
      route: 'titan' as const,
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
export function titanWorking({ state }: { state: TitanState }) {
  const card = state.cards[TITAN_CARD]

  return (card?.sessionActivity ?? card?.activity) === 'working'
}

export function titanChatQueue({ state }: { state: TitanState }) {
  const config = titanConfig({ state })
  const card = state.cards[TITAN_CARD]
  const messages = (state.titanMessages ?? []).filter(message => message.titan === config.titan.id)
  const working = titanWorking({ state })
  const view = titanQueueView({
    state,
    card,
  })

  const started: string[] = []

  let index = messages.length - 1

  // Newest first, stopping at the receipts the page keeps.
  while (index >= 0 && started.length < STARTED_RECEIPTS) {
    const message = messages[index]!

    if (ownerActor({ actor: message.actor }) && titanInputDispatched({
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

export type TitanChatQueue = ReturnType<typeof titanChatQueue>
