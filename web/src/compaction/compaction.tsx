import { useEffect, useState } from 'react'
import type { CompactInput, Compaction } from '../../../src/compaction/model.ts'
import { Button } from '../shared/ui/controls.tsx'
import { Disclosure } from '../shared/ui/disclosure.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { Tooltip } from '../shared/ui/tooltip.tsx'

export function CompactionRow({ operation }: { operation: Compaction }) {
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      if (operation.state !== 'running') {
        return
      }

      setNow(Date.now())
      const timer = setInterval(
        () => setNow(Date.now()),
        1000,
      )

      return () => clearInterval(timer)
    },
    [
      operation.id,
      operation.state,
    ],
  )
  const end = operation.endedAt ? Date.parse(operation.endedAt) : now
  const seconds = Math.max(
    0,
    Math.floor((end - Date.parse(operation.startedAt)) / 1000),
  )
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(
    2,
    '0',
  )}`
  const label = operation.state === 'running' ? `${operation.trigger === 'auto' ? 'Auto-compacting' : 'Compacting'}… ${elapsed}`
    : operation.state === 'done' ? `Compacted in ${elapsed}`
      : `Compaction ${operation.state === 'cancelled' ? 'cancelled' : 'failed'} after ${elapsed}`

  return (
    <div className="compaction-row" data-state={operation.state} role={operation.state === 'running' ? 'status' : undefined}>
      <Icon name={operation.state === 'running' ? 'context' : operation.state === 'done' ? 'check' : operation.state === 'cancelled' ? 'stop' : 'error'} size={14} />
      <span>{label}{operation.state !== 'running' && operation.trigger === 'auto' && ' · automatic'}{operation.error && <span className="compaction-reason">{operation.error}</span>}</span>
    </div>
  )
}

export function CompactionQueue({
  inputs,
  sendNow,
  disabled,
}: {
  inputs: CompactInput[]
  sendNow({ id }: { id: string }): Promise<void>
  disabled: boolean
}) {
  if (!inputs.length) {
    return null
  }

  return (
    <Disclosure className="compaction-queue" title={`Queued messages (${inputs.length})`}>
      {inputs.map(input => (
        <div className="compaction-queued" key={input.id}>
          <span>{input.text}</span>
          <Tooltip content="Send now">
            <Button aria-label="Send now" disabled={disabled} onClick={() => void sendNow({ id: input.id })}><Icon name="send" size={14} /></Button>
          </Tooltip>
        </div>
      ))}
    </Disclosure>
  )
}
