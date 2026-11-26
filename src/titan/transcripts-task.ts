import { activeCompaction } from '#workers/compaction/state.ts'
import { steeringHeld } from '#workers/steering.ts'
import { queuedAgentLabel } from '#workers/providers.ts'
import type { Card } from '#tasks/model.ts'
import type { ThreadEntry } from './transcripts-read.ts'

// Only what Othrys knows; a worker it does not run reads its inbox on its own time.
function waitingReason({ card }: { card: Card }) {
  if (steeringHeld({ card })) {
    return 'The task is on hold'
  }

  if (activeCompaction({ card })) {
    return 'The agent is compacting its conversation'
  }

  if (card.permissions?.some(request => request.status === 'pending')) {
    return 'The agent is waiting for a permission answer'
  }

  // A task with no worker yet names none.
  if (!card.agent) {
    return undefined
  }

  if (card.agent.host !== 'othrys') {
    return 'Waiting for the worker to read its inbox'
  }

  if ((card.sessionActivity ?? card.activity) === 'working') {
    return 'The agent is in the middle of a step'
  }

  return undefined
}

function titanPart({
  card,
  reply,
  received,
}: {
  card: Card
  reply: string
  received?: string
}) {
  const titan = card.replies?.find(r => r.id === `titan:${reply}`)

  if (received) {
    return {
      state: 'delivered' as const,
      received,
    }
  }

  if (!titan) {
    return {
      state: 'delivery_unknown' as const,
      detail: 'Titan queue was not confirmed',
    }
  }

  return {
    state: titan.state,
    detail: titan.detail,
  }
}

export function taskReceipt({
  card,
  reply,
  titanReceived,
}: {
  card: Card
  reply: string
  // When Titan took the copy of a task message sent to it.
  titanReceived?: string
}): Pick<ThreadEntry, 'receipt' | 'received' | 'waiting' | 'delivery' | 'targetAgent'> | undefined {
  const receipt = card.replies?.find(r => r.id === reply)

  if (!receipt) {
    return undefined
  }

  // An inbox message counts as received once the worker read it; Othrys handing it over is not enough.
  const steering = card.steering?.find(message => message.id === reply)
  const received = steering?.ack?.at ?? receipt.received
  let state = receipt.state

  if (received) {
    state = 'delivered'
  } else if (steering && state === 'delivered') {
    state = 'queued'
  }

  let waiting = state === 'queued' ? waitingReason({ card }) : receipt.detail

  if (state === 'queued' && receipt.worker) {
    waiting = queuedAgentLabel({ agent: receipt.worker.agent })
  }

  const entry: Pick<ThreadEntry, 'receipt' | 'received' | 'waiting' | 'delivery' | 'targetAgent'> = { receipt: state }

  if (receipt.worker) {
    entry.targetAgent = receipt.worker.agent
  }

  if (received) {
    entry.received = received
  }

  if (waiting) {
    entry.waiting = waiting
  }

  if (receipt.route && !receipt.worker) {
    entry.delivery = {
      titan: titanPart({
        card,
        reply,
        received: titanReceived,
      }),
    }

    if (receipt.route !== 'titan') {
      entry.delivery.agent = {
        state,
        detail: receipt.detail,
        received,
      }
    }
  }

  return entry
}
