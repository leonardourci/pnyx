import { useCallback, useEffect, useState } from 'react'
import { Tooltip, TooltipPanel, TooltipSection } from '#web-shared/ui/tooltip.tsx'
import type { HydraUsage } from '#workers/provider.ts'
import type { Command } from '#web-app/connection.ts'

const REFRESH_MS = 60_000

function tokens({ count }: { count: number }) {
  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(1))}m`
  }

  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count)
}

function resetsIn({
  at,
  now,
}: {
  at: string
  now: number
}) {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(at) - now) / 60_000),
  )

  if (minutes < 60) {
    return `${minutes}m`
  }

  if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }

  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor(minutes % (24 * 60) / 60)}h`
}

const capital = ({ text }: { text: string }) => text.charAt(0).toUpperCase() + text.slice(1)

// A ring filled by how much of the context window Hydra's session uses; hover shows the rest.
export function UsageRing({
  command,
  connected,
  turn,
}: {
  command: Command
  connected: boolean
  // Changes when a turn starts or ends, which is when the numbers move.
  turn: unknown
}) {
  const [
    usage,
    setUsage,
  ] = useState<HydraUsage | null>(null)
  const load = useCallback(
    () => command({
      name: 'hydra',
      args: ['usage'],
    }).then(
      result => setUsage(typeof result.usage === 'string' ? null : result as HydraUsage),
      // A missed refresh keeps the last reading; the next poll tries again.
      () => {},
    ),
    [command],
  )
  useEffect(
    () => {
      if (!connected) {
        return
      }

      void load()
      const timer = setInterval(
        () => void load(),
        REFRESH_MS,
      )

      return () => clearInterval(timer)
    },
    [
      connected,
      load,
      turn,
    ],
  )

  if (!usage || (usage.used === undefined && usage.cost === undefined
    && !usage.helper && !usage.windows?.length)) {
    return null
  }

  const percent = usage.used !== undefined && usage.window ? Math.min(
    100,
    Math.round(usage.used / usage.window * 100),
  ) : undefined
  const now = Date.now()
  const panel = (
    <TooltipPanel>
      {percent !== undefined && (
        <TooltipSection>
          <strong>Context window</strong>
          <span>
            {percent}% used · {tokens({ count: usage.used! })}
            {' / '}{tokens({ count: usage.window! })} tokens
          </span>
        </TooltipSection>
      )}
      {usage.cost !== undefined && (
        <TooltipSection>Hydra session ${usage.cost.toFixed(2)}</TooltipSection>
      )}
      {usage.helper && (
        <TooltipSection>
          <strong>Routine helper · {usage.helper.batches} {usage.helper.batches === 1 ? 'batch' : 'batches'}</strong>
          <span>
            {usage.helper.cost === undefined ? 'Cost unavailable' : `Cost $${usage.helper.cost.toFixed(2)}`}
            {usage.helper.measuredBatches < usage.helper.batches && (
              ` · measured ${usage.helper.measuredBatches}/${usage.helper.batches} batches`
            )}
          </span>
          {usage.helper.used !== undefined && (
            <span>Last context {tokens({ count: usage.helper.used })} tokens</span>
          )}
          {usage.helper.inputTokens !== undefined && (
            <span>Total input {tokens({ count: usage.helper.inputTokens })} tokens</span>
          )}
        </TooltipSection>
      )}
      {usage.combinedCost !== undefined && (
        <TooltipSection>Combined ${usage.combinedCost.toFixed(2)}</TooltipSection>
      )}
      {!!usage.windows?.length && (
        <TooltipSection>
          <strong>{usage.harness === 'codex' ? 'Codex' : 'Claude'}{usage.plan ? ` ${capital({ text: usage.plan })}` : ''}</strong>
          {usage.windows.map(window => (
            <span key={window.label} className="usage-window">
              <span>{capital({ text: window.label })} · {window.used}% used{window.resetsAt ? ` · resets in ${resetsIn({
                at: window.resetsAt,
                now,
              })}` : ''}
              </span>
              <span className="usage-bar"><i style={{ width: `${window.used}%` }} /></span>
            </span>
          ))}
        </TooltipSection>
      )}
      {usage.account && !usage.account.endsWith(':default') && (
        <TooltipSection className="usage-account">Account {usage.account}</TooltipSection>
      )}
    </TooltipPanel>
  )

  return (
    <Tooltip content={panel}>
      <span
        className="usage-ring"
        role="img"
        tabIndex={0}
        aria-label={percent === undefined ? 'Usage' : `Context window ${percent}% used`}
        onPointerEnter={() => void load()}
      >
        <svg
          viewBox="0 0 20 20"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r="7.5"
            pathLength="100"
          />
          {percent !== undefined && (
            <circle
              className="usage-fill"
              cx="10"
              cy="10"
              r="7.5"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
            />
          )}
        </svg>
      </span>
    </Tooltip>
  )
}
