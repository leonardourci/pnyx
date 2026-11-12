import { activeCompaction } from '#workers/compaction/state.ts'
import { steeringHeld } from '#workers/steering.ts'
import type { Card } from '#tasks/model.ts'
import type { ThreadEntry, ThreadPage } from './transcripts-read.ts'

export function taskUpdates({ card }: { card: Card }): ThreadEntry[] {
  return (card.statusLog ?? []).filter(s => s.note.trim() && s.actor !== 'web')
    .map(s => ({
      id: `update:${s.id}`,
      kind: 'message',
      role: 'assistant',
      text: s.note,
      at: s.at,
      task: card.id,
    }))
}

// Only what Pnyx knows; a worker it does not run reads its inbox on its own time.
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

  if (card.agent?.host !== 'pnyx') {
    return 'Waiting for the worker to read its inbox'
  }

  if ((card.sessionActivity ?? card.activity) === 'working') {
    return 'The agent is in the middle of a step'
  }

  return undefined
}

export function taskReceipt({
  card,
  reply,
}: {
  card: Card
  reply: string
}): Pick<ThreadEntry, 'receipt' | 'received' | 'waiting' | 'delivery'> | undefined {
  const receipt = card.replies?.find(r => r.id === reply)

  if (!receipt) {
    return undefined
  }

  // An inbox message counts as received once the worker read it; Pnyx handing it over is not enough.
  const steering = card.steering?.find(message => message.id === reply)
  const received = steering?.ack?.at ?? receipt.received
  let state = receipt.state

  if (received) {
    state = 'delivered'
  } else if (steering && state === 'delivered') {
    state = 'queued'
  }

  const waiting = state === 'queued' ? waitingReason({ card }) : undefined

  const hydra = card.replies?.find(r => r.id === `hydra:${reply}`)
  const delivery: ThreadEntry['delivery'] = receipt.route ? {
    ...(receipt.route !== 'hydra' ? {
      agent: {
        state,
        detail: receipt.detail,
        received,
      },
    } : {}),
    hydra: {
      state: hydra?.state ?? 'failed',
      detail: hydra?.detail ?? (!hydra ? 'Hydra queue was not confirmed' : undefined),
    },
  } : undefined

  const entry: Pick<ThreadEntry, 'receipt' | 'received' | 'waiting' | 'delivery'> = { receipt: state }

  if (received) {
    entry.received = received
  }

  if (waiting) {
    entry.waiting = waiting
  }

  if (delivery) {
    entry.delivery = delivery
  }

  return entry
}

export function withTaskReceipts({
  native,
  saved,
}: {
  native: ThreadPage
  saved: ThreadPage
}): ThreadPage {
  const receipts = saved.entries.filter(e => e.receipt !== undefined || e.delivery)
  const matched = new Set<string>()
  const entries = native.entries.map(entry => {
    const receipt = entry.kind === 'message' && entry.role.startsWith('user') && entry.replyId
      ? receipts.find(r => !matched.has(r.id) && r.replyId === entry.replyId
        && (r.part ?? 0) === (entry.part ?? 0)) : undefined

    if (receipt) {
      matched.add(receipt.id)

      return receipt
    }

    return entry
  })

  return {
    ...native,
    entries: [
      ...entries,
      ...receipts.filter(r => !matched.has(r.id)),
    ]
      .sort((
        a,
        b,
      ) => (a.at ?? '').localeCompare(b.at ?? '')),
  }
}
