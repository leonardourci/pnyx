import type { ReactNode } from 'react'
import type { Card, SavedLabelColor } from '#tasks/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { Label } from '#web-shared/ui/label.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { harnessName } from '#web-workers/view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { CardProjectLabel, CardState } from './card-state.tsx'
import { CardTitle } from './card-title.tsx'

export const CARD_SURFACE = 'card group/card relative m-0 flex min-h-0 min-w-0 w-full shrink-0 cursor-pointer flex-col gap-1.75 overflow-visible rounded-card border bg-card-fill px-2.75 pt-2.25 pb-2.5'
export const CARD_CONTENT = 'card-content flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden [&>*]:shrink-0 [&>.card-open-content]:shrink'

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
    <div className="card-labels flex shrink-0 flex-wrap gap-1 [&_.task-label]:whitespace-normal [&_.task-label]:wrap-anywhere [&_.task-label]:text-clip [&_.task-label]:px-1">
      {showProject && (
        <CardProjectLabel card={card} legacyProject={legacyProject} labelColors={colors} />
      )}
      {tags.map(tag => <Label key={tag} label={tag} colors={colors} />)}
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
      <div className="card-title-row flex min-w-0 items-start gap-1.25">
        {hasChildren && (
          <Button
            className="subtask-toggle min-w-3.5 flex-none px-0 py-0.5 aria-expanded:[&_svg]:rotate-90"
            aria-label={`Sub-tasks of ${card.title}`}
            aria-expanded={childrenOpen}
            onClick={event => {
              event.stopPropagation(); toggleChildren?.()
            }}
          ><Icon name="chevron_right" size={14} />
          </Button>
        )}
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
      </div>
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
