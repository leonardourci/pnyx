import { useCallback, useEffect, useState } from 'react'
import { Tooltip, TooltipPanel } from '#web-shared/ui/tooltip.tsx'
import type { Card } from '#tasks/model.ts'
import type { Command } from '#web-app/connection.ts'
import { Usage, usagePercent, usageTone } from './usage.tsx'

const REFRESH_MS = 60_000

export function useUsageRefresh({
  card,
  command,
  connected = true,
}: {
  card?: Card
  command: Command
  connected?: boolean
}) {
  const [
    refreshing,
    setRefreshing,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState<string>()
  const id = card?.id
  const session = card?.agent?.sessionId
  const load = useCallback(
    async ({ refresh = false }: { refresh?: boolean } = {}) => {
      if (!id || !session) {
        return
      }

      if (refresh) {
        setRefreshing(true)
      }

      try {
        await command({
          name: 'hydra',
          args: refresh ? [
            'usage',
            'refresh',
            '--task',
            id,
            '--force',
          ] : [
            'usage',
            'refresh',
            '--task',
            id,
          ],
        })
        setError(undefined)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (refresh) {
          setRefreshing(false)
        }
      }
    },
    [
      command,
      id,
      session,
    ],
  )
  useEffect(
    () => {
      if (!connected || !session) {
        return
      }

      load().catch(console.error)
      const timer = setInterval(
        () => {
          load().catch(console.error)
        },
        REFRESH_MS,
      )

      return () => clearInterval(timer)
    },
    [
      connected,
      load,
      session,
    ],
  )

  return {
    refresh: () => {
      load({ refresh: true }).catch(console.error)
    },
    refreshing,
    error,
  }
}

export function UsageRing({
  card,
  command,
  connected,
}: {
  card?: Card
  command: Command
  connected: boolean
}) {
  const reading = useUsageRefresh({
    card,
    command,
    connected,
  })
  const usage = card?.usage
  const percent = usagePercent({ usage })
  const tone = usageTone({ percent })
  let label = 'Context unavailable'

  if (percent !== undefined) {
    label = `Context window ${percent}% used`
  } else if (usage?.context) {
    const used = usage.context.used.toLocaleString()
    label = `Context ${used} tokens used; capacity unavailable`
  }

  const panel = <TooltipPanel><Usage usage={usage} {...reading} /></TooltipPanel>

  return (
    <Tooltip content={panel} interactive label="Usage details">
      <span
        className="usage-ring"
        role="img"
        tabIndex={0}
        aria-label={label}
        data-tone={tone}
      >
        <svg
          viewBox="0 0 30 30"
          width="30"
          height="30"
          aria-hidden="true"
        >
          <circle
            cx="15"
            cy="15"
            r="13.5"
            pathLength="100"
          />
          {percent !== undefined && (
            <circle
              className="usage-fill"
              cx="15"
              cy="15"
              r="13.5"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
            />
          )}
        </svg>
        {percent !== undefined && <span className="usage-percent" aria-hidden="true">{percent}<small>%</small></span>}
      </span>
    </Tooltip>
  )
}
