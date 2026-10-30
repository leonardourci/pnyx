import type { ReactNode } from 'react'
import { statusLabel } from '#tasks/card-status.ts'
import type { Card, SavedLabelColor } from '#tasks/model.ts'
import { WorkingDots } from '#web-hydra/streaming.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { Label } from '#web-shared/ui/label.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { relativeTime } from './brief.ts'
import type { ObservedStatus } from './observed-status.ts'

// The card and the Oracle's preview share it so their status never drifts apart.
export function CardState({
  card,
  status,
  now,
  labelColors,
  tooltips = false,
  children,
}: {
  card: Card
  status: ObservedStatus
  now: number
  labelColors?: SavedLabelColor[]
  // The card explains status and age in tooltips; a preview shows them plain, out of the Tab order.
  tooltips?: boolean
  children?: ReactNode
}) {
  const text = statusLabel({ status })
  const at = status.at || card.updatedAt
  const created = card.createdAt || card.statusLog?.[0]?.at
  const createdText = created ? `Created ${new Date(created).toLocaleString()}` : 'Creation time not recorded'
  const pill = (
    <span className={`agent-activity activity-${status.kind}`} aria-label={text}>
      {status.kind === 'working' ? <WorkingDots /> : <i aria-hidden="true" />}
      {text}
    </span>
  )
  const since = (
    <time className="card-since" dateTime={at} tabIndex={tooltips ? 0 : undefined}>
      {relativeTime({
        at,
        now,
      })}
    </time>
  )

  return (
    <div className="card-state">
      {tooltips ? <Tooltip content={status.details}>{pill}</Tooltip> : pill}
      {tooltips ? <Tooltip content={createdText}>{since}</Tooltip> : since}
      {card.project && (
        <Label
          project
          label={card.project}
          text={projectTitle({ project: card.project })}
          colors={labelColors}
        />
      )}
      {children}
    </div>
  )
}
