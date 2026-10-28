import { activeCompaction } from '../compaction/state.ts'
import { pausedDeclaration } from '../tasks/lifecycle.ts'
import type { HydraEvent, HydraState } from '../app/model.ts'
import type { Card } from '../tasks/model.ts'
import type { SteeringClaim } from './model.ts'
import { cardSessionId } from './session-attachments.ts'

export function pendingSteering({ card }: { card: Card }) {
  if (activeCompaction({ card })) {
    return []
  }

  return (card.steering ?? []).filter(message => !message.ack).sort((
    a,
    b,
  ) => Number(b.id === card.compaction?.priority) - Number(a.id === card.compaction?.priority))
}

export function steeringHeld({ card }: { card: Card }): boolean {
  return Boolean(card.hold || pausedDeclaration({ card })?.hold)
}

export function steeringClaim({ card }: { card: Card }): SteeringClaim | undefined {
  const session = cardSessionId({ card })

  if (!session) {
    return undefined
  }

  return {
    session,
    generation: card.steeringGeneration ?? card.createdSeq,
  }
}

export function steeringWorkerIdentity({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): string | undefined {
  const session = cardSessionId({ card })
  const origin = session && state.sessions?.[session]?.originCardId
  const createdSeq = origin && state.cards[origin]?.createdSeq

  return Object.entries(state.eventIds).find(([
    , seq,
  ]) => seq === createdSeq)?.[0]
}

export function sameClaim({
  current,
  claim,
}: {
  current?: SteeringClaim
  claim: SteeringClaim
}): boolean {
  return current?.session === claim.session && current.generation === claim.generation
}

export function applySteering({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  if (event.type !== 'task.steering.queued' && event.type !== 'task.steering.notified' && event.type !== 'task.steering.handled' && event.type !== 'task.steering.recovery') {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  if (event.type === 'task.steering.queued') {
    const messages = card.steering ?? []

    if (messages.some(message => message.id === event.data.message.id)) {
      return true
    }

    card.steering = [
      ...messages,
      structuredClone(event.data.message),
    ]
  } else if (event.type === 'task.steering.notified') {
    const message = card.steering?.find(message => message.id === event.data.message)

    if (!message || message.attempts.some(attempt => attempt.id === event.data.attempt.id)) {
      return true
    }

    message.attempts.push(structuredClone(event.data.attempt))
  } else if (event.type === 'task.steering.recovery') {
    const message = card.steering?.find(message => message.id === event.data.message)

    if (!message || message.ack) {
      return true
    }

    const recovery = message.recovery ?? []
    const index = recovery.findIndex(attempt => attempt.id === event.data.recovery.id)

    if (index < 0) {
      recovery.push(structuredClone(event.data.recovery))
    } else {
      recovery[index] = structuredClone(event.data.recovery)
    }

    message.recovery = recovery
  } else {
    const message = pendingSteering({ card })[0]

    if (!message || message.id !== event.data.message || !sameClaim({
      current: steeringClaim({ card }),
      claim: event.data.ack.claim,
    })) {
      return true
    }

    message.ack = structuredClone(event.data.ack)

    if (card.compaction) {
      card.compaction.inputs = card.compaction.inputs.filter(input => input.id !== message.id)
    }
  }

  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}
