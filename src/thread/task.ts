import type { Card } from '../core/model.ts'
import type { ThreadEntry, ThreadPage } from './read.ts'

export function taskUpdates({ card }: { card: Card }): ThreadEntry[] {
  return (card.statusLog ?? []).filter(s => s.note.trim() && s.actor !== 'web')
    .map(s => ({ id: `update:${s.id}`, kind: 'message', role: 'assistant', text: s.note, at: s.at, task: card.id }))
}

export function taskConversation({ card, entries }: {
  card: Card
  entries: ThreadEntry[]
}): ThreadEntry[] {
  const prompt = card.initialPrompt ?? card.brief
  const initial: ThreadEntry[] = prompt?.trim() ? [{ id: `brief:${card.id}`, kind: 'message', role: 'user', text: prompt, task: card.id }] : []
  const updates = taskUpdates({ card })
  const ids = new Set(entries.map(e => e.id))
  const stream = [...updates.filter(e => !ids.has(e.id)), ...entries.filter(e => !e.initial)].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

  return [...initial, ...stream]
}

export function withTaskReceipts({ native, saved }: {
  native: ThreadPage
  saved: ThreadPage
}): ThreadPage {
  const receipts = saved.entries.filter(e => e.delivery)
  const matched = new Set<string>()
  const entries = native.entries.map(entry => {
    const receipt = entry.kind === 'message' && entry.role.startsWith('user')
      ? receipts.find(r => !matched.has(r.id) && r.text === entry.text) : undefined

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
