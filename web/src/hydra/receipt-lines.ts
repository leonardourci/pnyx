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
type Route = 'agent' | 'hydra'
const ROUTES: Record<Route, string> = {
  agent: 'Agent',
  hydra: 'Hydra',
}
// The agent's part shows before Hydra's, whatever order the delivery record lists them in.
const ROUTE_ORDER: Route[] = [
  'agent',
  'hydra',
]

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
  route?: Route
}): ReceiptLine {
  const prefix = route ? `${ROUTES[route]}: ` : ''
  const failed = state === 'failed' || state === 'delivery_unknown'

  if (received) {
    return {
      key,
      text: `${prefix}Received ${clock({ at: received })}`,
      tone: 'received',
      icon: 'check',
      hint: sent
        ? `Sent ${clock({ at: sent })}, received ${duration({ ms: Date.parse(received) - Date.parse(sent) })} later`
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

// A transcript copy's time is when the agent read it; the owner's message shows when it was sent.
export const sentTime = ({ entry }: { entry: Pick<ThreadEntry, 'sent' | 'at'> }) => entry.sent ?? entry.at

// Received means the agent's harness confirmed it took the message, never that Pnyx handed it over.
export function receiptLines({ entry }: { entry: ThreadEntry }): ReceiptLine[] {
  const sent = sentTime({ entry })

  const { delivery } = entry

  if (delivery) {
    return ROUTE_ORDER.flatMap(route => {
      const part = delivery[route]

      return part ? [
        line({
          key: route,
          route,
          state: part.state,
          received: part.received,
          sent,
          // The agent's wait is the task's own; Hydra's part has only its delivery detail.
          why: part.detail ?? (route === 'agent' ? entry.waiting : undefined),
        }),
      ] : []
    })
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
