import type { ReactNode } from 'react'
import type { Card, SavedLabelColor } from '#tasks/model.ts'
import { Label } from '#web-shared/ui/label.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { harnessName } from '#web-workers/view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { CardProjectLabel, CardState } from './card-state.tsx'
import { CardTitle } from './card-title.tsx'
import { CardHeading } from './card-shell.tsx'

export function cardTint({
  card,
  colors,
}: {
  card: Card
  colors?: SavedLabelColor[]
}) {
  const label = colors?.find(entry => entry.label === card.project)
    ?? colors?.find(entry => card.tags.includes(entry.label))

  return label?.color
}

export function TaskLabels({
  card,
  showProject,
  legacyProject,
  colors,
  children,
}: {
  card: Card
  showProject: boolean
  legacyProject?: boolean
  colors?: SavedLabelColor[]
  children?: ReactNode
}) {
  const tags = card.tags.filter(tag => tag !== card.project)

  if (!showProject && !tags.length && !children) {
    return null
  }

  return (
    <div className="card-labels flex shrink-0 flex-wrap gap-1">
      {showProject && (
        <CardProjectLabel
          card={card}
          legacyProject={legacyProject}
          labelColors={colors}
          compact
        />
      )}
      {tags.map(tag => (
        <Label
          key={tag}
          label={tag}
          colors={colors}
          wrap
          compact
        />
      ))}
      {children}
    </div>
  )
}

export function CardSummary({
  card,
  status,
  now,
  colors,
  legacyProject,
  progress,
  hasChildren,
  childrenOpen,
  toggleChildren,
  open,
  agentDetails,
  editing = false,
  tabIndex = -1,
  trailingLabel,
}: {
  card: Card
  status: ObservedStatus
  now: number
  colors?: SavedLabelColor[]
  legacyProject?: boolean
  progress?: string
  hasChildren?: boolean
  childrenOpen?: boolean
  toggleChildren?(): void
  open?(): void
  agentDetails?: ReactNode
  editing?: boolean
  tabIndex?: number
  trailingLabel?: ReactNode
}) {
  const agent = card.agent && <span className="card-agent ml-auto inline-flex text-muted" tabIndex={agentDetails ? 0 : undefined} aria-label={harnessName({ provider: card.agent.provider })}><Icon name={card.agent.provider} /></span>

  return (
    <>
      <CardState
        card={card}
        status={status}
        now={now}
        labelColors={colors}
        tooltips={!!open}
        compact
        progress={progress}
        showProject={false}
      >
        {agentDetails ? <Tooltip content={agentDetails} interactive label="Agent details">{agent}</Tooltip> : agent}
      </CardState>
      <CardHeading
        title={card.title}
        hasChildren={hasChildren}
        childrenOpen={childrenOpen}
        toggleChildren={toggleChildren}
      >
        {!editing && (
          <CardTitle
            title={card.title}
            expanded={false}
            open={open ?? (() => {})}
            data-card={card.id}
            data-key-scope="hydra"
            tabIndex={tabIndex}
          />
        )}
      </CardHeading>
      <TaskLabels
        card={card}
        showProject={!!card.project}
        legacyProject={legacyProject}
        colors={colors}
      >{trailingLabel}
      </TaskLabels>
    </>
  )
}
