import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { receiptLines, type ReceiptLine } from './receipt-lines.ts'

function Receipt({ line }: { line: ReceiptLine }) {
  const tones: Record<string, string> = {
    received: 'text-green',
    delivered: 'text-green',
    failed: 'text-red',
    delivery_unknown: 'text-gold',
  }
  const appearance = tones[line.tone] ?? ''
  const shown = (
    <span className={`receipt-line inline-flex items-center gap-1 receipt-${line.tone} ${appearance}`} tabIndex={line.hint ? 0 : undefined}>
      {line.icon && <Icon name={line.icon} size={14} />}
      {line.text}
    </span>
  )

  return line.hint ? <Tooltip content={line.hint}>{shown}</Tooltip> : shown
}

export function MessageReceipt({ entry }: { entry: ThreadEntry }) {
  const lines = receiptLines({ entry })

  if (!lines.length) {
    return null
  }

  return (
    <span className="receipt inline-flex gap-2 mt-0 py-0 px-1 text-inherit text-meta text-right" role="status">
      {lines.map(line => <Receipt key={line.key} line={line} />)}
    </span>
  )
}
