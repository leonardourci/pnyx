import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { receiptLines, type ReceiptLine } from './receipt-lines.ts'

function Receipt({ line }: { line: ReceiptLine }) {
  const shown = (
    <span className={`receipt-line receipt-${line.tone}`} tabIndex={line.hint ? 0 : undefined}>
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
    <span className="receipt" role="status">
      {lines.map(line => <Receipt key={line.key} line={line} />)}
    </span>
  )
}
