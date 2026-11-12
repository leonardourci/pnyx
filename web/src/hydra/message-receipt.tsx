import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { clock, duration } from './chat.ts'

const LABELS: Record<string, string> = {
  queued: 'Queued',
  delivered: 'Delivered',
  delivery_unknown: 'Delivery unknown',
  failed: 'Not delivered',
}
const ICONS: Record<string, string> = {
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
  state: string
  received?: string
  sent?: string
  why?: string
  route?: string
}) {
  const label = received ? `Received ${clock({ at: received })}` : LABELS[state] ?? state
  const icon = received ? 'check' : ICONS[state]
  const waited = received && sent ? Date.parse(received) - Date.parse(sent) : undefined
  const title = waited !== undefined && sent
    ? `Sent ${clock({ at: sent })}, received ${duration({ ms: waited })} later`
    : why
  const prefix = route ? `${ROUTES[route] ?? route}: ` : ''

  return (
    <span className={`receipt-${received ? 'received' : state}`} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {prefix}
      {label}
    </span>
  )
}

// Received means the agent's harness confirmed it took the message, never that Pnyx handed it over.
export function MessageReceipt({ entry }: { entry: ThreadEntry }) {
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
            sent={entry.at}
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
        sent={entry.at}
        why={entry.waiting}
      />
    </span>
  )
}
