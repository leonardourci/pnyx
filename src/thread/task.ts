import type { Card } from '../tasks/model.ts'
import type { ThreadEntry, ThreadPage } from './read.ts'

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

export function taskReceipt({
  card,
  reply,
}: {
  card: Card
  reply: string
}): Pick<ThreadEntry, 'receipt' | 'delivery'> | undefined {
  const receipt = card.replies?.find(r => r.id === reply)

  if (!receipt) {
    return undefined
  }

  const hydra = card.replies?.find(r => r.id === `hydra:${reply}`)
  const delivery: ThreadEntry['delivery'] = receipt.route ? {
    ...(receipt.route !== 'hydra' ? {
      agent: {
        state: receipt.state,
        detail: receipt.detail,
      },
    } : {}),
    hydra: {
      state: hydra?.state ?? 'failed',
      detail: hydra?.detail ?? (!hydra ? 'Hydra queue was not confirmed' : undefined),
    },
  } : undefined

  return {
    receipt: receipt.state,
    ...(delivery ? { delivery } : {}),
  }
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
