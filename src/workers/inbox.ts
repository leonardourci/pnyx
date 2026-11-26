import { inform } from '#app/command-notices.ts'
import { randomUUID } from 'node:crypto'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { TitanError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import type { SteeringAck, SteeringAttempt, SteeringClaim, SteeringMessage } from './model.ts'
import type { Writer } from '#app/writer.ts'
import { pendingSteering, sameClaim, steeringClaim, steeringWorkerIdentity } from './steering.ts'

function invalid({ message }: { message: string }): never {
  throw new TitanError({
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

  if (card.id === TITAN_CARD) {
    invalid({ message: 'Choose a native task for its steering inbox' })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Steering accessed on a hidden task',
      clear: `Review the visibility of task ${card.id} in the UI.`,
    })
  }

  return card
}

export function requireSteeringWorker({
  state,
  card,
  actor,
  worker,
}: {
  state: TitanState
  card: Card
  actor: string
  worker?: string
}): void {
  if (actor !== `worker:${card.id}`) {
    inform({
      task: card.id,
      reason: 'Steering acknowledged by another actor',
      clear: `Read tasks/${card.id}/task.log to inspect its steering`,
    })

    return
  }

  const launchIdentityRequired = card.agent?.host === 'othrys' || worker !== undefined

  if (launchIdentityRequired && (!worker || worker !== steeringWorkerIdentity({
    state,
    card,
  }))) {
    throw new TitanError({
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
    throw new TitanError({
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
  derived = false,
}: {
  writer: Writer
  ref: string
  id: string
  ack: SteeringAck
  meta: Meta
  worker?: string
  derived?: boolean
}): SteeringMessage {
  const card = inboxTask({
    writer,
    ref,
  })

  if (meta.actor !== `worker:${card.id}` || ack.actor !== meta.actor) {
    inform({
      task: card.id,
      reason: 'Steering acknowledged by another actor',
      clear: `Read tasks/${card.id}/task.log to inspect its steering`,
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

    if (derived || !message.ackDerived) {
      return message
    }
  }

  if (!message.ack && pendingSteering({ card })[0]?.id !== id) {
    inform({
      task: card.id,
      reason: 'Steering handled before an older pending instruction',
      clear: `Read tasks/${card.id}/task.log to inspect the remaining instructions`,
    })
  }

  if (ack.outcome === 'blocked' && !ack.note?.trim()) {
    inform({
      task: card.id,
      reason: 'Steering marked blocked without an explanatory note',
      clear: 'Record the blocker in the assigned worker.log.',
    })
    ack = {
      ...ack,
      note: 'Marked blocked by the explicit acknowledgement',
    }
  }

  const event: Extract<TitanEvent, { type: 'task.steering.handled' }> = {
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
  }

  if (derived) {
    event.derived = true
  }

  writer.append({ event })

  return writer.state.cards[card.id]!.steering!.find(message => message.id === id)!
}
