import type { HydraState } from '#app/model.ts'
import { knownCards } from '#tasks/select.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { QueuedUpdate } from '#hydra/wakes.ts'
import { LiveLabel } from '#web-shared/ui/live-label.tsx'
import { Tooltip,TooltipPanel,TooltipSection } from '#web-shared/ui/tooltip.tsx'
import { useEffect,useState,type ReactNode } from 'react'
import { clock,duration } from './chat.ts'
import { WorkingDots } from './streaming.tsx'

export function Running({
  since,
  running,
  label,
  reading,
  waiting,
  state,
  children,
}: {
  since: string | null
  running: boolean
  label: string
  reading: QueuedUpdate[]
  waiting: QueuedUpdate[]
  state: HydraState
  children?: ReactNode
}) {
  const [
    now,
    setNow,
  ] = useState(() => Date.now())
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        1000,
      )

      return () => clearInterval(timer)
    },
    [],
  )

  const words = queueWords({
    reading: reading.length,
    waiting: waiting.length,
    tasks: new Set(reading.map(update => update.card).filter(card => card !== HYDRA_CARD)).size,
  })
  const cards = knownCards({ state })

  return (
    <div
      className="chat-running"
      title={since ? `Started ${clock({
        at: since,
        seconds: true,
      })}` : undefined}
    >
      <span
        className="chat-running-status"
        role="status"
        aria-label={statusName({
          running,
          label,
          words,
        })}
      >
        {running && <WorkingDots />}
        {since && <span aria-hidden="true">{duration({ ms: now - Date.parse(since) })}</span>}
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
                        {cards[update.card]?.title ?? 'Hydra'} · {update.kind ?? 'update'}
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

function statusName({
  running,
  label,
  words,
}: {
  running: boolean
  label: string
  words: string | null
}): string | undefined {
  if (running && words) {
    return `${label}. ${words}`
  }

  if (running) {
    return label
  }

  return words ?? undefined
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
