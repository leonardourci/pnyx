import { randomUUID } from 'node:crypto'
import type { Meta } from '../app/command-meta.ts'
import { findCard } from '../tasks/push-rules.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import type { HydraState } from '../app/model.ts'
import { EVENT_VERSION } from '../store/events.ts'
import { HydraError } from '../store/errors.ts'
import type { Card } from '../tasks/model.ts'
import type { SteeringAck, SteeringAttempt, SteeringClaim, SteeringMessage } from '../workers/model.ts'
import { liveTask } from '../tasks/select.ts'
import type { Writer } from '../app/writer.ts'
import { pendingSteering, sameClaim, steeringClaim, steeringWorkerIdentity } from './state.ts'

function invalid({ message }: { message: string }): never {
  throw new HydraError({
    message,
    code: 'VALIDATION_ERROR',
  })
}

export function inboxTask({
  writer,
  ref,
}: {
  writer: Pick<Writer, 'state'>
  ref: string
}): Card {
  const card = findCard({
    state: writer.state,
    ref,
  })

  if (!liveTask({ card }) || card.id === HYDRA_CARD) {
    invalid({ message: 'Choose a native task for its steering inbox' })
  }

  if (card.mirror || card.sourceRefs.some(source => source.adapter === 'firstmate')) {
    invalid({ message: 'Firstmate tasks use Firstmate’s steering inbox' })
  }

  return card
}

export function requireSteeringWorker({
  state,
  card,
  actor,
  worker,
}: {
  state: HydraState
  card: Card
  actor: string
  worker?: string
}): void {
  if (actor !== `worker:${card.id}`) {
    throw new HydraError({
      message: 'Only this task’s worker can acknowledge steering',
      code: 'NOT_ALLOWED',
    })
  }

  if (card.agent?.host === 'pnyx' && (!worker || worker !== steeringWorkerIdentity({
    state,
    card,
  }))) {
    throw new HydraError({
      message: 'This worker launch no longer owns the task’s inbox',
      code: 'STALE_CLAIM',
    })
  }
}

function eventBase({
  writer,
  card,
  meta,
}: {
  writer: Writer
  card: Card
  meta: Meta
}) {
  return {
    v: EVENT_VERSION,
    seq: writer.state.seq + 1,
    id: randomUUID(),
    cardId: card.id,
    at: meta.at,
    actor: meta.actor,
    reason: meta.reason,
  }
}

export function enqueueSteering({
  writer,
  ref,
  id,
  text,
  source,
  reply,
  meta,
}: {
  writer: Writer
  ref: string
  id: string
  text: string
  source: string
  reply?: string
  meta: Meta
}): SteeringMessage {
  const card = inboxTask({
    writer,
    ref,
  })

  if (!id.trim() || !text.trim() || !source.trim()) {
    invalid({ message: 'Message id, source and text must be nonempty' })
  }

  const known = card.steering?.find(message => message.id === id)

  if (known) {
    if (known.text !== text || known.source !== source || known.reply !== reply) {
      invalid({ message: 'Message id already belongs to a different instruction' })
    }

    return known
  }

  const messages = card.steering ?? []
  const message: SteeringMessage = {
    id,
    order: (messages.at(-1)?.order ?? 0) + 1,
    text,
    source,
    at: meta.at,
    actor: meta.actor,
    attempts: [],
  }
  const claim = steeringClaim({ card })

  if (claim) {
    message.queuedFor = claim
  }

  if (reply !== undefined) {
    message.reply = reply
  }

  writer.append({
    event: {
      ...eventBase({
        writer,
        card,
        meta,
      }),
      type: 'task.steering.queued',
      data: { message },
    },
  })

  return writer.state.cards[card.id]!.steering!.at(-1)!
}

function requireClaim({
  card,
  claim,
}: {
  card: Card
  claim: SteeringClaim
}): void {
  if (!sameClaim({
    current: steeringClaim({ card }),
    claim,
  })) {
    throw new HydraError({
      message: 'Steering claim is not the task’s active session and generation',
      code: 'STALE_CLAIM',
    })
  }
}

export function recordSteeringAttempt({
  writer,
  ref,
  id,
  attempt,
  meta,
}: {
  writer: Writer
  ref: string
  id: string
  attempt: SteeringAttempt
  meta: Meta
}): SteeringMessage {
  const card = inboxTask({
    writer,
    ref,
  })
  requireClaim({
    card,
    claim: attempt.claim,
  })
  const message = card.steering?.find(message => message.id === id)

  if (!message) {
    invalid({ message: 'Steering message not found on this task' })
  }

  const known = message.attempts.find(known => known.id === attempt.id)

  if (known) {
    return message
  }

  if (message.ack) {
    invalid({ message: 'This steering message is already handled' })
  }

  if (!attempt.id.trim()) {
    invalid({ message: 'Notification attempt id must be nonempty' })
  }

  writer.append({
    event: {
      ...eventBase({
        writer,
        card,
        meta,
      }),
      type: 'task.steering.notified',
      data: {
        message: id,
        attempt,
      },
    },
  })

  return writer.state.cards[card.id]!.steering!.find(message => message.id === id)!
}

export function acknowledgeSteering({
  writer,
  ref,
  id,
  ack,
  meta,
  worker,
}: {
  writer: Writer
  ref: string
  id: string
  ack: SteeringAck
  meta: Meta
  worker?: string
}): SteeringMessage {
  const card = inboxTask({
    writer,
    ref,
  })

  if (meta.actor !== `worker:${card.id}` || ack.actor !== meta.actor) {
    throw new HydraError({
      message: 'Only this task’s worker can acknowledge steering',
      code: 'NOT_ALLOWED',
    })
  }

  requireSteeringWorker({
    state: writer.state,
    card,
    actor: meta.actor,
    worker,
  })
  requireClaim({
    card,
    claim: ack.claim,
  })
  const message = card.steering?.find(message => message.id === id)

  if (!message) {
    invalid({ message: 'Steering message not found on this task' })
  }

  if (message.ack) {
    if (!sameClaim({
      current: message.ack.claim,
      claim: ack.claim,
    })) {
      invalid({ message: 'This message was handled by another assignment' })
    }

    return message
  }

  if (pendingSteering({ card })[0]?.id !== id) {
    invalid({ message: 'Handle the oldest pending instruction first' })
  }

  if (ack.outcome === 'blocked' && !ack.note?.trim()) {
    invalid({ message: 'A blocked acknowledgement needs a note explaining what prevents incorporation' })
  }

  writer.append({
    event: {
      ...eventBase({
        writer,
        card,
        meta,
      }),
      type: 'task.steering.handled',
      data: {
        message: id,
        ack,
      },
    },
  })

  return writer.state.cards[card.id]!.steering!.find(message => message.id === id)!
}
