import { createContext, Fragment, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
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
  names: Map<string, string>
  pattern?: RegExp
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
  const parent = useContext(TaskReferences)
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
        return parent
      }

      const names = new Map(Object.keys(references).map(id => [
        id,
        id,
      ]))
      const titles = new Map<string, string[]>()

      for (const [
        id,
        reference,
      ] of Object.entries(references)) {
        const matches = titles.get(reference.title) ?? []
        matches.push(id)
        titles.set(
          reference.title,
          matches,
        )
      }

      for (const [
        title,
        ids,
      ] of titles) {
        if (title && ids.length === 1 && !names.has(title)) {
          names.set(
            title,
            ids[0]!,
          )
        }
      }

      const literals = [...names.keys()].sort((
        a,
        b,
      ) => b.length - a.length || a.localeCompare(b))
        .map(name => name.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        ))
      const pattern = literals.length ? new RegExp(
        `(?<![\\p{L}\\p{N}_-])(${literals.join('|')})(?![\\p{L}\\p{N}_-])`,
        'gu',
      ) : undefined

      return {
        references,
        names,
        pattern,
        openTask: canOpen ? ({ id }: { id: string }) => current.current?.({ id }) : undefined,
      }
    },
    [
      references,
      canOpen,
      parent,
    ],
  )

  return <TaskReferences.Provider value={value}>{children}</TaskReferences.Provider>
}

export function TaskReferenceText({ text }: { text: string }) {
  const context = useContext(TaskReferences)

  if (!context?.pattern) {
    return text
  }

  return text.split(context.pattern).map((
    part,
    index,
  ) => {
    const id = index % 2 === 1 ? context.names.get(part) : undefined

    return id ? <TaskReference key={index} id={id} /> : <Fragment key={index}>{part}</Fragment>
  })
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
    <Tooltip anchorClassName="inline" content={reference ? `${reference.title} · ${state}` : 'Open referenced task'}>
      <InlineButton
        className={`button task-mention task-reference inline min-h-0 max-w-full rounded-none border-0 bg-transparent p-0 text-left align-baseline font-inherit wrap-anywhere whitespace-inherit text-inherit hover:bg-transparent aria-disabled:cursor-default aria-disabled:opacity-45 column-${reference?.column ?? 'custom'} ${className}`}
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
