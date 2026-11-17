import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { movedOrder, type PhysicalMove } from '#web-shared/ui/physical-drag.ts'
import { rankOf } from '#tasks/select.ts'
import { statusPriority, taskRollup } from './project-view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { CLOSED_CARD_MIN_WIDTH, SUBTASK_INDENT } from './project-layout.ts'

export interface FamilyCard {
  card: Card
  status: ObservedStatus
  progress?: string
  childrenOpen?: boolean
  hasChildren?: boolean
  toggleChildren?(): void
}

export function TaskFamily({
  card,
  state,
  actions,
  selected,
  preview,
  renderCard,
}: {
  card: Card
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  preview: PhysicalMove | null
  renderCard({
    card,
    status,
    progress,
    hasChildren,
    childrenOpen,
    toggleChildren,
  }: FamilyCard): ReactNode
}) {
  const [
    expanded,
    setExpanded,
  ] = useState(false)
  const {
    status,
    children,
    done,
  } = taskRollup({
    state,
    card,
    actions,
  })
  const sorted = children.toSorted((
    a,
    b,
  ) => statusPriority({
    status: taskRollup({
      state,
      card: a,
      actions,
    }).status,
  }) - statusPriority({
    status: taskRollup({
      state,
      card: b,
      actions,
    }).status,
  }) || rankOf({ card: a }) - rankOf({ card: b }))
  const shown = preview?.kind === 'task' && !preview.nest && preview.scope === preview.targetScope
    ? movedOrder({
      items: sorted,
      ...preview,
      key: ({ item }) => item.id,
    }) : sorted
  const previousCount = useRef(children.length)
  useEffect(
    () => {
      if (children.length > previousCount.current) {
        setExpanded(true)
      }

      previousCount.current = children.length
    },
    [children.length],
  )
  const childSelected = children.some(child => selected.includes(child.id))
  const childrenOpen = expanded || childSelected
  const opened = [
    card,
    ...children,
  ].filter(item => selected.includes(item.id))
  const style = {
    '--closed-card-min': `${CLOSED_CARD_MIN_WIDTH}px`,
    '--subtask-indent': `${SUBTASK_INDENT}px`,
  } as CSSProperties
  const className = `task-family min-w-0 flex-[1_1_var(--closed-card-min)] ${opened.length ? 'family-open basis-full' : ''}`

  return (
    <div className={className} style={style} data-family={card.id}>
      {renderCard({
        card,
        status,
        progress: children.length ? `${done}/${children.length}` : undefined,
        hasChildren: children.length > 0,
        childrenOpen,
        toggleChildren: () => setExpanded(value => !value),
      })}
      {children.length > 0 && childrenOpen && (
        <div className="subtasks mt-1.75 flex flex-col gap-1.75 border-l border-line pl-[calc(var(--subtask-indent)-1px)]">
          {shown.filter(child => !child.hidden || selected.includes(child.id)).map(child => (
            <div key={child.key} data-child={child.id}>
              {renderCard({
                card: child,
                status: taskRollup({
                  state,
                  card: child,
                  actions,
                }).status,
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
