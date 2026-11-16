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
  const pill = (
    <span className={`agent-activity activity-${status.kind}`} aria-label={text}>
      {status.kind === 'working' ? <WorkingDots /> : <i aria-hidden="true" />}
      <span className="activity-text">{text}</span>
      {progress && <span className="task-progress">{progress}</span>}
    </span>
  )
  const since = (
    <time className="card-since" dateTime={at} tabIndex={tooltips ? 0 : undefined}>
      {age}
    </time>
  )

  return (
    <div className="card-state">
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
