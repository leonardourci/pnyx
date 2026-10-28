import { useEffect, useState } from 'react'
import type { CompactInput, Compaction } from '#workers/compaction/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'

// m:ss since startedAt, ticking while running.
export function useElapsed({
  startedAt,
  endedAt,
  running,
}: {
  startedAt: string
  endedAt?: string
  running: boolean
}) {
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      if (!running) {
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
      startedAt,
      running,
    ],
  )
  const end = endedAt ? Date.parse(endedAt) : now
  const seconds = Math.max(
    0,
    Math.floor((end - Date.parse(startedAt)) / 1000),
  )

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(
    2,
    '0',
  )}`
}

export function CompactionRow({ operation }: { operation: Compaction }) {
  const elapsed = useElapsed({
    startedAt: operation.startedAt,
    endedAt: operation.endedAt,
    running: operation.state === 'running',
  })
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
