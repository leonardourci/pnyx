import type { ReactNode } from 'react'
import { statusLabel } from '#tasks/card-status.ts'
import type { Card, SavedLabelColor } from '#tasks/model.ts'
import { WorkingDots } from '#web-hydra/streaming.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { Label } from '#web-shared/ui/label.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { relativeTime } from './brief.ts'
import type { ObservedStatus } from './observed-status.ts'

const COMPACT_STATES: Record<string, string> = {
  asks: 'needs you',
  working: 'running',
  waiting: 'waiting',
  paused: 'paused',
  'asks-hydra': 'waiting',
  answering: 'sending',
  unknown: 'unknown',
}

// The card and the Oracle's preview share it so their status never drifts apart.
export function CardState({
  card,
  progress,
  showProject = true,
  legacyProject = false,
  status,
  now,
  labelColors,
  tooltips = false,
  compact = false,
  children,
}: {
  card: Card
  progress?: string
  showProject?: boolean
  legacyProject?: boolean
  status: ObservedStatus
  now: number
  labelColors?: SavedLabelColor[]
  // The card explains status and age in tooltips; a preview shows them plain, out of the Tab order.
  tooltips?: boolean
  compact?: boolean
  children?: ReactNode
}) {
  const label = compact ? COMPACT_STATES[status.kind] ?? status.text : status.text
  const text = statusLabel({
    status: {
      ...status,
      text: label,
    },
  })
  const at = status.at || card.updatedAt
  const created = card.createdAt || card.statusLog?.[0]?.at
  const createdText = created ? `Created ${new Date(created).toLocaleString()}` : 'Creation time not recorded'
  const age = relativeTime({
    at,
    now,
    compact,
  })
  const colors: Record<string, string> = {
    asks: 'text-gold',
    'asks-hydra': 'text-slate',
    working: 'text-green',
    done: 'text-green',
    stopped: 'text-red',
    blocked: 'text-red',
    waiting: 'text-slate',
  }
  const color = colors[status.kind] ?? 'text-muted'
  const pill = (
    <span className={`agent-activity activity-${status.kind} flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-full bg-activity-fill px-1.75 py-0.5 text-meta font-semibold whitespace-nowrap ${color} ${compact ? 'gap-1 px-1.25' : ''}`} aria-label={text}>
      {status.kind === 'working' ? <WorkingDots /> : <i className="size-1.75 shrink-0 rounded-full border border-current" aria-hidden="true" />}
      <span className="activity-text min-w-0 truncate">{text}</span>
      {progress && <span className="task-progress shrink-0 border-l border-current pl-1 tabular-nums">{progress}</span>}
    </span>
  )
  const since = (
    <time className="card-since text-meta whitespace-nowrap text-muted" dateTime={at} tabIndex={tooltips ? 0 : undefined}>
      {age}
    </time>
  )

  return (
    <div className={`card-state flex min-h-5 min-w-0 items-center gap-x-2 gap-y-1 text-meta [&>*]:shrink-0 [&>.tooltip-anchor:has(.agent-activity)]:shrink [&>.tooltip-anchor:has(.card-agent)]:ml-auto [&>.tooltip-anchor:has(.project-label)]:min-w-0 [&>.tooltip-anchor:has(.project-label)]:max-w-full [&>.tooltip-anchor:has(.project-label)]:shrink [&>.tooltip-anchor:has(.project-label)]:overflow-hidden ${compact ? 'flex-nowrap gap-x-1.5 whitespace-nowrap' : 'flex-wrap'}`}>
      {tooltips ? <Tooltip content={status.details}>{pill}</Tooltip> : pill}
      {tooltips ? <Tooltip content={createdText}>{since}</Tooltip> : since}
      {showProject && (
        <CardProjectLabel card={card} legacyProject={legacyProject} labelColors={labelColors} />
      )}
      {children}
    </div>
  )
}

export function CardProjectLabel({
  card,
  legacyProject = false,
  labelColors,
}: {
  card: Card
  legacyProject?: boolean
  labelColors?: SavedLabelColor[]
}) {
  if (!card.project) {
    return null
  }

  return (
    <Label
      project={!legacyProject}
      label={card.project}
      text={projectTitle({ project: card.project })}
      colors={legacyProject ? undefined : labelColors}
    />
  )
}
