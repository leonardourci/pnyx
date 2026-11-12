import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import type { ReplyState } from '#workers/model.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
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

function Receipt({
  state,
  received,
  sent,
  why,
  route,
}: {
  state: ReplyState
  received?: string
  sent?: string
  why?: string
  route?: string
}) {
  const label = received ? `Received ${clock({ at: received })}` : LABELS[state]
  const icon = received ? 'check' : ICONS[state]
  const tone = received ? 'received' : state
  const prefix = route ? `${ROUTES[route] ?? route}: ` : ''
  const failed = state === 'failed' || state === 'delivery_unknown'
  // A failure keeps its reason in view; a wait or a receipt explains itself on hover or focus.
  const detail = !received && failed && why ? ` · ${why}` : ''
  const waited = received && sent ? Date.parse(received) - Date.parse(sent) : undefined
  let hint = failed ? undefined : why

  if (waited !== undefined && sent) {
    hint = `Sent ${clock({ at: sent })}, received ${duration({ ms: waited })} later`
  }

  const line = (
    <span className={`receipt-line receipt-${tone}`} tabIndex={hint ? 0 : undefined}>
      {icon && <Icon name={icon} size={14} />}
      {prefix}
      {label}
      {detail}
    </span>
  )

  return hint ? <Tooltip content={hint}>{line}</Tooltip> : line
}

// Received means the agent's harness confirmed it took the message, never that Pnyx handed it over.
export function MessageReceipt({ entry }: { entry: ThreadEntry }) {
  const sent = entry.sent ?? entry.at

  if (entry.delivery) {
    return (
      <span className="receipt" role="status">
        {Object.entries(entry.delivery).map(([
          route,
          delivery,
        ]) => (
          <Receipt
            key={route}
            route={route}
            state={delivery.state}
            received={delivery.received}
            sent={sent}
            why={delivery.detail}
          />
        ))}
      </span>
    )
  }

  if (!entry.receipt) {
    return null
  }

  return (
    <span className="receipt" role="status">
      <Receipt
        state={entry.receipt}
        received={entry.received}
        sent={sent}
        why={entry.waiting}
      />
    </span>
  )
}
