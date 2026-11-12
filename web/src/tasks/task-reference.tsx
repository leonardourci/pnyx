import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { InlineButton } from '#web-shared/ui/controls.tsx'
import { ReferenceBadge } from '#web-hydra/reference-badge.tsx'
import { CHIP_SPACE } from '#web-hydra/draft.ts'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'

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
export const SavedTaskLabels = createContext(false)

export function TaskReferencesProvider({
  references,
  openTask,
  children,
}: {
  references?: Record<string, TaskReferenceData>
  openTask?: OpenTask
  children: ReactNode
}) {
  const current = useRef(openTask)
  useLayoutEffect(
    () => {
      current.current = openTask
    },
    [openTask],
  )
  const canOpen = openTask !== undefined
  const value = useMemo(
    () => {
      if (!references) {
        return undefined
      }

      return {
        references,
        openTask: canOpen ? ({ id }: { id: string }) => current.current?.({ id }) : undefined,
      }
    },
    [
      references,
      canOpen,
    ],
  )

  return <TaskReferences.Provider value={value}>{children}</TaskReferences.Provider>
}

export function TaskReference({
  id,
  children,
  savedLabel,
  openTask,
  className = '',
}: {
  id: string
  children?: ReactNode
  savedLabel?: string
  openTask?: OpenTask
  className?: string
}) {
  const context = useContext(TaskReferences)
  const savedLabels = useContext(SavedTaskLabels)
  const reference = context && Object.hasOwn(
    context.references,
    id,
  ) ? context.references[id] : undefined
  const open = context ? context.openTask : openTask
  const savedTitle = savedLabels ? savedLabel : undefined
  const label = savedTitle ?? reference?.title ?? children ?? 'Unavailable task'
  const state = reference?.state ?? 'Unavailable'

  if (!context && !open) {
    return children
  }

  return (
    <Tooltip content={reference ? `${reference.title} · ${state}` : 'Open referenced task'}>
      <InlineButton
        className={`button task-mention task-reference column-${reference?.column ?? 'custom'} ${className}`}
        contentEditable={false}
        data-task-ref={id}
        data-state={reference?.kind}
        disabled={!open}
        aria-label={reference ? `Open task ${reference.title}; ${state}` : undefined}
        onClick={() => open?.({ id })}
      >
        <span className="task-reference-space">{CHIP_SPACE}</span>
        <ReferenceBadge
          icons={[
            'task-card',
            taskStateIcon({ kind: reference?.kind }),
          ]}
          className={`column-${reference?.column ?? 'custom'}`}
          data-kind="task"
        ><span className="task-reference-title">{label}</span>
        </ReferenceBadge>
        <span className="task-reference-space">{CHIP_SPACE}</span>
      </InlineButton>
    </Tooltip>
  )
}
