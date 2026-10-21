import { createContext, useContext, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'
import { Tooltip } from './tooltip.tsx'

const stateIcons: Record<string, string> = {
  working: 'in_progress',
  asks: 'needs_you',
  done: 'done',
  finished: 'check',
  stopped: 'parked',
  'not-started': 'queued',
}

export interface TaskReferenceData {
  title: string
  state: string
  kind: string
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
      <Button
        className={`task-mention task-reference ${className}`}
        contentEditable={false}
        data-task-ref={id}
        data-state={reference?.kind}
        disabled={!open}
        aria-label={reference ? `Open task ${reference.title}; ${state}` : undefined}
        onClick={() => open?.({ id })}
      >
        <Icon name="task-card" size={14} />
        {context && (
          <span className="task-reference-state" role="img" aria-label={state}>
            <Icon name={stateIcons[reference?.kind ?? ''] ?? 'queued'} size={14} />
          </span>
        )}
        <span className="task-reference-title">{label}</span>
        <Icon name="external" size={13} />
      </Button>
    </Tooltip>
  )
}
