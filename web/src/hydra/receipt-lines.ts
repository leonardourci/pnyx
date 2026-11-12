import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import type { ReplyState } from '#workers/model.ts'
import { clock, duration } from './chat.ts'

const LABELS: Record<ReplyState, string> = {
  queued: 'Queued',
  delivered: 'Delivered',
  delivery_unknown: 'Delivery unknown',
  failed: 'Not delivered',
}
const ICONS: Partial<Record<ReplyState, string>> = {
  queued: 'waiting',
  delivery_unknown: 'error',
  failed: 'error',
}
const ROUTES: Record<string, string> = {
  hydra: 'Hydra',
  agent: 'Agent',
}

export interface ReceiptLine {
  key: string
  text: string
  tone: string
  icon?: string
  // Why it waits, or how long it took to be received.
  hint?: string
}

function line({
  key,
  state,
  received,
  sent,
  why,
  route,
}: {
  key: string
  state: ReplyState
  received?: string
  sent?: string
  why?: string
  route?: string
}): ReceiptLine {
  const prefix = route ? `${ROUTES[route] ?? route}: ` : ''
  const failed = state === 'failed' || state === 'delivery_unknown'

  if (received) {
    const waited = sent ? Date.parse(received) - Date.parse(sent) : undefined

    return {
      key,
      text: `${prefix}Received ${clock({ at: received })}`,
      tone: 'received',
      icon: 'check',
      hint: waited !== undefined && sent
        ? `Sent ${clock({ at: sent })}, received ${duration({ ms: waited })} later`
        : undefined,
    }
  }

  // A failure keeps its reason in view; a wait explains itself on hover or focus.
  const detail = failed && why ? ` · ${why}` : ''

  return {
    key,
    text: `${prefix}${LABELS[state]}${detail}`,
    tone: state,
    icon: ICONS[state],
    hint: failed ? undefined : why,
  }
}

// Received means the agent's harness confirmed it took the message, never that Pnyx handed it over.
export function receiptLines({ entry }: { entry: ThreadEntry }): ReceiptLine[] {
  const sent = entry.sent ?? entry.at

  if (entry.delivery) {
    return Object.entries(entry.delivery).map(([
      route,
      delivery,
    ]) => line({
      key: route,
      route,
      state: delivery.state,
      received: delivery.received,
      sent,
      // The agent's wait is the task's own; Hydra's part has only its delivery detail.
      why: delivery.detail ?? (route === 'agent' ? entry.waiting : undefined),
    }))
  }

  if (!entry.receipt) {
    return []
  }

  return [
    line({
      key: 'receipt',
      state: entry.receipt,
      received: entry.received,
      sent,
      why: entry.waiting,
    }),
  ]
}
