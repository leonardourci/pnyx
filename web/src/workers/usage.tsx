import type { AgentUsage } from '#workers/provider.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { TooltipSection } from '#web-shared/ui/tooltip.tsx'

const WARNING_PERCENT = 70
const CRITICAL_PERCENT = 90
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

export function usagePercent({ usage }: { usage?: AgentUsage }) {
  const context = usage?.context

  if (!context?.window) {
    return undefined
  }

  return Math.min(
    100,
    Math.round(context.used / context.window * 100),
  )
}

export function usageTone({ percent }: { percent?: number }) {
  if (percent !== undefined && percent >= CRITICAL_PERCENT) {
    return 'critical'
  }

  if (percent !== undefined && percent >= WARNING_PERCENT) {
    return 'warning'
  }

  return 'normal'
}

function tokens({ count }: { count: number }) {
  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(1))}m`
  }

  return count >= 1_000 ? `${Number((count / 1_000).toFixed(1))}k` : count.toLocaleString()
}

function resetLabel({
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

  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / MINUTES_PER_HOUR)

  if (hours < HOURS_PER_DAY) {
    return `${hours}h ${minutes % MINUTES_PER_HOUR}m`
  }

  return `${Math.floor(hours / HOURS_PER_DAY)}d ${hours % HOURS_PER_DAY}h`
}

function UsageBar({
  percent,
  label,
}: {
  percent: number
  label: string
}) {
  const width = Math.min(
    100,
    Math.max(
      0,
      percent,
    ),
  )

  return (
    <span
      className="usage-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i style={{ width: `${width}%` }} />
    </span>
  )
}

export function Usage({
  usage,
  refresh,
  refreshing = false,
  error,
  now = Date.now(),
}: {
  usage?: AgentUsage
  refresh?(): void
  refreshing?: boolean
  error?: string
  now?: number
}) {
  const context = usage?.context
  const who = usage?.who
  const recorded = usage?.recorded
  const windows = usage?.windows ?? []
  const percent = usagePercent({ usage })
  const tone = usageTone({ percent })
  const provider = who?.provider ?? 'Agent'
  const source = `From ${provider} · last request`
  const sourceIcon = who?.icon ?? 'info'
  const cost = recorded?.cost
  let footerTitle = 'Usage'
  let footerValue = 'Unavailable'
  let footerSource: string | undefined
  let footerIcon = 'info'

  if (cost !== undefined) {
    footerTitle = 'Session cost'
    footerValue = `$${cost.toFixed(2)}`
    footerSource = `From ${provider}`
    footerIcon = 'cost'
  } else if (context) {
    footerTitle = 'Context tokens'
    footerValue = `${tokens({ count: context.used })} tokens`
    footerSource = `Cost unavailable · from ${provider}`
    footerIcon = 'context'
  }

  const showFooter = context !== undefined || cost !== undefined

  return (
    <span className="shared-usage">
      <TooltipSection className="shared-context">
        <span className="shared-header">
          <span className="usage-icon-line"><Icon name="context" size={13} /><strong>Context window</strong></span>
          {percent !== undefined && <span className="shared-context-percent">{percent}% used</span>}
        </span>
        {context ? (
          <span className="usage-context-reading" data-tone={tone}>
            <span className="context-amounts">
              <span><b>{tokens({ count: context.used })} tokens</b> used</span>
              {context.left !== undefined && (
                <span><b>{tokens({ count: context.left })}</b> left</span>
              )}
            </span>
            {percent !== undefined && <UsageBar percent={percent} label="Context window use" />}
            {context.window !== undefined && (
              <span className="context-capacity">{tokens({ count: context.window })} token capacity</span>
            )}
            <span className="shared-source"><Icon name={sourceIcon} size={13} />{source}</span>
          </span>
        ) : <span className="context-empty" title={usage?.unavailable}>Usage unavailable</span>}
      </TooltipSection>
      <TooltipSection className="shared-plan">
        <span className="shared-header">
          <span className="usage-icon-line"><Icon name="effort" size={13} /><strong>Plan limits</strong></span>
          {refresh && (
            <button
              type="button"
              className="plan-refresh"
              aria-label="Refresh plan limits"
              aria-disabled={refreshing}
              aria-busy={refreshing}
              onClick={refreshing ? undefined : refresh}
            ><Icon name="reset" size={13} />
            </button>
          )}
        </span>
        <span className="plan-account"><Icon name={who?.icon ?? 'agent'} size={13} /><span>{provider}</span>{who?.account && <span>{who.account}</span>}{who?.plan && <span className="subscription-badge">{who.plan}</span>}</span>
        {who?.model && <span className="shared-sub">{who.model}</span>}
        {windows.map(window => {
          const windowTone = usageTone({ percent: window.used })
          const resetsAt = window.resetsAt
          const reset = resetsAt && Number.isFinite(Date.parse(resetsAt)) ? {
            at: resetsAt,
            relative: resetLabel({
              at: resetsAt,
              now,
            }),
            date: new Date(resetsAt).toLocaleString(
              undefined,
              {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              },
            ),
          } : undefined

          return (
            <span className="shared-window" key={window.label} data-tone={windowTone}>
              <span className="shared-window-label"><span>{window.label}</span><span>{window.used}% used</span></span>
              <UsageBar percent={window.used} label={`${window.label} plan use`} />
              {reset && (
                <span className="shared-reset">
                  <Icon name="reminder" size={11} />
                  <span>Resets in {reset.relative}</span>
                  <span>·</span>
                  <time dateTime={reset.at}>{reset.date}</time>
                </span>
              )}
            </span>
          )
        })}
        {!windows.length && <span className="shared-sub">Plan limits unavailable</span>}
        {error && <span role="status">{error}</span>}
      </TooltipSection>
      {showFooter && (
        <TooltipSection className="shared-footer">
          <span className="usage-icon-line"><Icon name={footerIcon} size={13} /><span>{footerTitle}</span><b>{footerValue}</b></span>
          <span className="shared-sub">{footerSource}</span>
        </TooltipSection>
      )}
      {recorded?.tokens !== undefined && (
        <TooltipSection className="shared-footer recorded-usage">
          <span>Recorded task tokens <b>{recorded.tokens.toLocaleString()}</b></span>
          <span className="shared-sub">{(recorded.worker ?? 0).toLocaleString()} worker · {(recorded.hydra ?? 0).toLocaleString()} attributed Hydra</span>
          <span className="shared-sub">Includes earlier workers. Unattributed Hydra turns excluded.</span>
          {recorded.sharedHydra && <span className="shared-sub">Includes Hydra turns shared with other tasks.</span>}
        </TooltipSection>
      )}
      {usage?.helper && (
        <TooltipSection className="shared-footer">
          <strong>Routine helper · {usage.helper.batches} batches</strong>
          <span>{usage.helper.cost === undefined ? 'Cost unavailable' : `Cost $${usage.helper.cost.toFixed(2)}`}</span>
          {usage.helper.measuredBatches < usage.helper.batches && (
            <span>Measured {usage.helper.measuredBatches}/{usage.helper.batches} batches</span>
          )}
          {usage.helper.used !== undefined && (
            <span>Last context {tokens({ count: usage.helper.used })} tokens</span>
          )}
          {usage.helper.inputTokens !== undefined && (
            <span>Total input {tokens({ count: usage.helper.inputTokens })} tokens</span>
          )}
          {usage.combinedCost !== undefined && (
            <span>Combined ${usage.combinedCost.toFixed(2)}</span>
          )}
        </TooltipSection>
      )}
      {!!recorded?.unavailable && <span className="shared-sub">{recorded.unavailable} transcript(s) unavailable.</span>}
    </span>
  )
}
