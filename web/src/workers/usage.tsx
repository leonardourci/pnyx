import { IconButton } from '#web-shared/ui/icon-button.tsx'
import type { AgentUsage } from '#workers/provider.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { UsageRow, UsageStack, UsageText, UsageSection, USAGE_TONE } from './usage-ui.tsx'

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
      className="usage-bar block h-1.25 overflow-hidden rounded bg-usage-line [&>i]:block [&>i]:h-full [&>i]:rounded [&>i]:bg-usage-fill"
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
    <span className="shared-usage flex flex-col w-full max-w-(--spacing-usage-content) p-3.25 gap-2.5">
      <UsageSection className="shared-context">
        <UsageRow variant="header" className="shared-header">
          <UsageRow variant="icon" className="usage-icon-line"><Icon name="context" size={ICON_SIZE.inline} /><strong>Context window</strong></UsageRow>
          {percent !== undefined && <span className="shared-context-percent text-usage-detail">{percent}% used</span>}
        </UsageRow>
        {context ? (
          <UsageStack className={`usage-context-reading ${USAGE_TONE}`} data-tone={tone}>
            <UsageRow variant="amounts" className="context-amounts">
              <span><b>{tokens({ count: context.used })} tokens</b> used</span>
              {context.left !== undefined && (
                <span><b>{tokens({ count: context.left })}</b> left</span>
              )}
            </UsageRow>
            {percent !== undefined && <UsageBar percent={percent} label="Context window use" />}
            {context.window !== undefined && (
              <UsageText className="context-capacity">{tokens({ count: context.window })} token capacity</UsageText>
            )}
            <UsageRow variant="source" className="shared-source"><Icon name={sourceIcon} size={ICON_SIZE.inline} />{source}</UsageRow>
          </UsageStack>
        ) : <span className="context-empty text-xs opacity-70 py-1" title={usage?.unavailable}>Usage unavailable</span>}
      </UsageSection>
      <UsageSection divided className="shared-plan">
        <UsageRow variant="header" className="shared-header">
          <UsageRow variant="icon" className="usage-icon-line"><Icon name="effort" size={ICON_SIZE.inline} /><strong>Plan limits</strong></UsageRow>
          {refresh && (
            <IconButton
              icon="reset"
              size="usage"
              iconSize={ICON_SIZE.inline}
              className="plan-refresh"
              label="Refresh plan limits"
              aria-disabled={refreshing}
              aria-busy={refreshing}
              onClick={refreshing ? undefined : refresh}
            />
          )}
        </UsageRow>
        <UsageRow variant="account" className="plan-account"><Icon name={who?.icon ?? 'agent'} size={ICON_SIZE.inline} /><span>{provider}</span>{who?.account && <span>{who.account}</span>}{who?.plan && <span className="subscription-badge text-usage-detail border border-usage-badge px-1.75 py-px rounded-compact leading-[1.4] capitalize">{who.plan}</span>}</UsageRow>
        {who?.model && <UsageText className="shared-sub">{who.model}</UsageText>}
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
            <UsageStack
              compact
              className={`shared-window mt-2 ${USAGE_TONE}`}
              key={window.label}
              data-tone={windowTone}
            >
              <UsageRow variant="header" className="shared-window-label"><span>{window.label}</span><span>{window.used}% used</span></UsageRow>
              <UsageBar percent={window.used} label={`${window.label} plan use`} />
              {reset && (
                <UsageRow variant="reset" className="shared-reset">
                  <Icon name="reminder" size={ICON_SIZE.badge} />
                  <span>Resets in {reset.relative}</span>
                  <span>·</span>
                  <time dateTime={reset.at}>{reset.date}</time>
                </UsageRow>
              )}
            </UsageStack>
          )
        })}
        {!windows.length && <UsageText className="shared-sub">Plan limits unavailable</UsageText>}
        {error && <span role="status">{error}</span>}
      </UsageSection>
      {showFooter && (
        <UsageSection divided className="shared-footer">
          <UsageRow variant="icon" className="usage-icon-line"><Icon name={footerIcon} size={ICON_SIZE.inline} /><span>{footerTitle}</span><b>{footerValue}</b></UsageRow>
          <UsageText className="shared-sub">{footerSource}</UsageText>
        </UsageSection>
      )}
      {recorded?.tokens !== undefined && (
        <UsageSection divided className="shared-footer recorded-usage">
          <span>Recorded task tokens <b>{recorded.tokens.toLocaleString()}</b></span>
          <UsageText className="shared-sub">{(recorded.worker ?? 0).toLocaleString()} worker · {(recorded.hydra ?? 0).toLocaleString()} attributed Hydra</UsageText>
          <UsageText className="shared-sub">Includes earlier workers. Unattributed Hydra turns excluded.</UsageText>
          {recorded.sharedHydra && <UsageText className="shared-sub">Includes Hydra turns shared with other tasks.</UsageText>}
        </UsageSection>
      )}
      {usage?.helper && (
        <UsageSection divided className="shared-footer">
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
        </UsageSection>
      )}
      {!!recorded?.unavailable && <UsageText className="shared-sub">{recorded.unavailable} transcript(s) unavailable.</UsageText>}
    </span>
  )
}
