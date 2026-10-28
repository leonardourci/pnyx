import { createContext, useContext, type ReactNode } from 'react'
import { InlineButton } from '../shared/ui/controls.tsx'
import { ReferenceBadge } from '../components/ui/reference-badge.tsx'
import { CHIP_SPACE } from '../hydra/draft.ts'
import { Tooltip } from '../shared/ui/tooltip.tsx'

const stateIcons: Record<string, string> = {
  working: 'in_progress',
  asks: 'needs_you',
  done: 'done',
  finished: 'check',
  stopped: 'parked',
  'not-started': 'queued',
}

export const taskStateIcon = ({ kind }: { kind?: string }) => stateIcons[kind ?? ''] ?? 'queued'

export interface TaskReferenceData {
  title: string
  state: string
  kind: string
  column?: string
}

type OpenTask = ({ id }: { id: string }) => void
const TaskReferences = createContext<{
  references: Record<string, TaskReferenceData>
  openTask?: OpenTask
} | undefined>(undefined)

export function TaskReferencesProvider({
  references,
  openTask,
  children,
}: {
  references?: Record<string, TaskReferenceData>
  openTask?: OpenTask
  children: ReactNode
}) {
  return (
    <TaskReferences.Provider
      value={references ? {
        references,
        openTask,
      } : undefined}
    >{children}
    </TaskReferences.Provider>
  )
}

export function TaskReference({
  id,
  children,
  openTask,
  className = '',
}: {
  id: string
  children?: ReactNode
  openTask?: OpenTask
  className?: string
}) {
  const context = useContext(TaskReferences)
  const reference = context && Object.hasOwn(
    context.references,
    id,
  ) ? context.references[id] : undefined
  const open = context ? reference ? context.openTask : undefined : openTask
  const label = reference?.title ?? children ?? 'Unavailable task'
  const state = reference?.state ?? 'Unavailable'

  if (!context && !open) {
    return children
  }

  return (
    <Tooltip content={context && !reference ? 'Task unavailable in this Hydra' : reference ? `${reference.title} · ${state}` : 'Open referenced task'}>
      <InlineButton
        className={`button task-mention task-reference column-${reference?.column ?? 'custom'} ${className}`}
        contentEditable={false}
        data-task-ref={id}
        data-state={reference?.kind}
        disabled={!open}
        aria-label={reference ? `Open task ${reference.title}; ${state}` : undefined}
        onClick={() => open?.({ id })}
      >
        {CHIP_SPACE}
        <ReferenceBadge
          icons={[
            'task-card',
            taskStateIcon({ kind: reference?.kind }),
          ]}
          className={`column-${reference?.column ?? 'custom'}`}
          data-kind="task"
        >{label}
        </ReferenceBadge>
        {CHIP_SPACE}
      </InlineButton>
    </Tooltip>
  )
}
