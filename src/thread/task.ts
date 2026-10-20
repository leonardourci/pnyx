import type { Card } from '../core/model.ts'
import type { ThreadEntry, ThreadPage } from './read.ts'
import { taskMentions } from '../mentions/mentions.ts'
import { withoutInjected } from '../oracle/text.ts'

export function taskUpdates({ card }: { card: Card }): ThreadEntry[] {
  return (card.statusLog ?? []).filter(s => s.note.trim() && s.actor !== 'web')
    .map(s => ({ id: `update:${s.id}`, kind: 'message', role: 'assistant', text: s.note, at: s.at, task: card.id }))
}

export function taskReceipt({ card, reply }: {
  card: Card
  reply: string
}): Pick<ThreadEntry, 'receipt' | 'delivery'> | undefined {
  const receipt = card.replies?.find(r => r.id === reply)

  if (!receipt) {
    return undefined
  }

  const hydra = card.replies?.find(r => r.id === `hydra:${reply}`)
  const delivery: ThreadEntry['delivery'] = receipt.route ? {
    ...(receipt.route !== 'hydra' ? { agent: { state: receipt.state, detail: receipt.detail } } : {}),
    hydra: { state: hydra?.state ?? 'failed', detail: hydra?.detail ?? (!hydra ? 'Hydra queue was not confirmed' : undefined) },
  } : undefined

  return { receipt: receipt.state, ...(delivery ? { delivery } : {}) }
}

export function taskConversation({ card, entries }: {
  card: Card
  entries: ThreadEntry[]
}): ThreadEntry[] {
  const prompt = card.initialPrompt ?? card.brief
  const initial: ThreadEntry[] = prompt?.trim() ? [{ id: `brief:${card.id}`, kind: 'message', role: 'user', text: prompt, task: card.id }] : []
  const updates = taskUpdates({ card })
  const ids = new Set(entries.map(e => e.id))
  const launch = `You are the Pnyx worker for task ${card.id} `

  // The launch prompt opens with the worker header, which the thread does not show.
  const launched = ({ text }: { text: string }) => {
    const shown = withoutInjected({ text })

    return shown.startsWith(launch) || [prompt, card.brief].some(given =>
      given?.trim() && shown.startsWith(`${given}\n\n${launch}`))
  }

  const conversation = entries.filter(entry => !entry.initial && !(entry.kind === 'message'
    && /^(user|You)$/.test(entry.role) && launched({ text: entry.text })))
  const matched = new Set<string>()

  for (const receipt of conversation) {
    const state = receipt.delivery?.agent?.state ?? receipt.receipt
    const at = receipt.at

    if (!receipt.replyId || !receipt.session || !state || state === 'failed' || !at
      || (receipt.delivery && !receipt.delivery.agent)) {
      continue
    }

    const text = receipt.text.trim().replace(/\s+/g, ' ')
    const mentioned = taskMentions({ text: receipt.text }).length > 0
    const copy = conversation.find(entry => !matched.has(entry.id) && !entry.replyId
      && entry.session === receipt.session
      && entry.kind === 'message' && /^(user|You)( · continued)?$/.test(entry.role)
      && entry.at && entry.at >= at
      && (entry.part ?? 0) === (receipt.part ?? 0)
      && (entry.text.trim().replace(/\s+/g, ' ') === text || (mentioned
        && entry.text.trim().replace(/\s+/g, ' ')
          .startsWith(`${text} Referenced tasks (context only): `))))

    if (copy) {
      matched.add(copy.id)
    }
  }

  const stream = [
    ...updates.filter(e => !ids.has(e.id)),
    ...conversation.filter(e => !matched.has(e.id)),
  ]
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

  return [...initial, ...stream.map(entry => entry.replyId
    ? { ...entry, ...taskReceipt({ card, reply: entry.replyId }) } : entry)]
}

export function withTaskReceipts({ native, saved }: {
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
    entries: [...entries, ...receipts.filter(r => !matched.has(r.id))]
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
  }
}
