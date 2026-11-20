import { OperationLine } from '#web-shared/ui/operation-line.tsx'
import { useEffect, useState } from 'react'
import type { Compaction } from '#workers/compaction/model.ts'
import { Disclosure } from '#web-shared/ui/disclosure.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

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
    <OperationLine data-state={operation.state} role={operation.state === 'running' ? 'status' : undefined}>
      <Icon name={operation.state === 'running' ? 'context' : operation.state === 'done' ? 'check' : operation.state === 'cancelled' ? 'stop' : 'error'} size={ICON_SIZE.inline} />
      <span>{label}{operation.state !== 'running' && operation.trigger === 'auto' && ' · automatic'}{operation.error && <span className="compaction-reason mt-1 block">{operation.error}</span>}</span>
    </OperationLine>
  )
}

// Compactions with nothing between them, folded to one line that opens to each.
export function CompactionRun({ operations }: { operations: Compaction[] }) {
  const allDone = operations.every(operation => operation.state === 'done')
  const label = allDone ? `Compacted ${operations.length} times` : `${operations.length} compactions`

  return (
    <Disclosure
      className="compaction-run [&_.disclosure-body]:grid [&_.disclosure-body]:gap-1.5 [&_.disclosure-body]:pl-5.5 [&>summary]:block"
      title={(
        <OperationLine as="span">
          <Icon name="context" size={ICON_SIZE.inline} />
          <span>{label}</span>
        </OperationLine>
      )}
    >
      {operations.map(operation => <CompactionRow key={operation.id} operation={operation} />)}
    </Disclosure>
  )
}
