import type { TitanState } from '#app/model.ts'
import { knownCards } from '#tasks/select.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { QueuedUpdate } from '#titan/wakes.ts'
import { LiveLabel } from '#web-shared/ui/live-label.tsx'
import { Tooltip,TooltipPanel,TooltipSection } from '#web-shared/ui/tooltip.tsx'
import { useEffect,useState,type ReactNode } from 'react'
import { clock,duration } from './chat.ts'
import { WorkingDots } from './streaming.tsx'

export function Running({
  since,
  running,
  label,
  statusName: labelName,
  reading,
  waiting,
  state,
  children,
}: {
  since: string | null
  running: boolean
  label: string
  statusName?: string
  reading: QueuedUpdate[]
  waiting: QueuedUpdate[]
  state: TitanState
  children?: ReactNode
}) {
  const [
    now,
    setNow,
  ] = useState(() => Date.now())
  useEffect(
    () => {
      if (!running || !since) {
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
      running,
      since,
    ],
  )

  const words = queueWords({
    reading: reading.length,
    waiting: waiting.length,
    tasks: new Set(reading.map(update => update.card).filter(card => card !== TITAN_CARD)).size,
  })
  const cards = knownCards({ state })

  return (
    <div
      className="chat-running absolute left-4 bottom-1.5 z-3 flex flex-wrap items-center gap-y-1 gap-x-2 py-0.5 pr-2 pl-0 rounded-card bg-surface text-muted text-meta tabular-nums max-w-[calc(100%-_--spacing(8))] [&_.working-dots_i]:size-1.25 in-[.chat-frame]:static in-[.chat-frame]:mx-(--chat-inset) in-[.chat-frame]:max-w-[calc(100%-2*var(--chat-inset))] in-[.chat-frame]:py-1 in-[.chat-frame]:px-0 in-[.chat-frame]:flex-none"
      title={running && since ? `Started ${clock({
        at: since,
        seconds: true,
      })}` : undefined}
    >
      <span
        className="chat-running-status inline-flex items-center gap-2 min-w-0 max-w-full [&>:not(.action-bubble,.chat-status-label)]:shrink-0 [&>:not(.action-bubble,.chat-status-label)]:whitespace-nowrap"
      >
        {running && <WorkingDots />}
        {running && since && (
          <span aria-hidden="true">{duration({
            ms: Math.max(
              0,
              now - Date.parse(since),
            ),
          })}
          </span>
        )}
        <span
          className="chat-status-label min-w-0 break-words"
          role="status"
          aria-label={labelName}
          data-status={label}
        >{label}
        </span>
        {children}
        {words && (
          <Tooltip
            content={(
              <TooltipPanel>
                {[
                  {
                    label: 'Reading',
                    updates: reading,
                  },
                  {
                    label: 'Waiting',
                    updates: waiting,
                  },
                ].filter(group => group.updates.length).map(group => (
                  <TooltipSection key={group.label}>
                    <strong>{group.label} {group.updates.length} {group.updates.length === 1 ? 'update' : 'updates'}</strong>
                    {group.updates.map(update => (
                      <span key={update.seq}>
                        {cards[update.card]?.title ?? 'Titan'} · {update.kind ?? 'update'}
                      </span>
                    ))}
                  </TooltipSection>
                ))}
              </TooltipPanel>
            )}
          >
            <span tabIndex={0}>
              <LiveLabel
                value={words}
                keyOf={({ value }) => value}
                render={({ value }) => value}
              />
            </span>
          </Tooltip>
        )}
      </span>

    </div>
  )
}

function queueWords({
  reading,
  waiting,
  tasks,
}: {
  reading: number
  waiting: number
  tasks: number
}): string | null {
  const count = waiting > 0 ? `+${waiting} waiting` : null
  const read = `Reading ${reading} ${reading === 1 ? 'update' : 'updates'}${tasks > 1 ? ` across ${tasks} tasks` : ''}`

  if (reading > 0 && waiting > 0) {
    return `${read} · ${count}`
  }

  if (reading > 0) {
    return read
  }

  if (waiting > 0) {
    return count
  }

  return null
}
