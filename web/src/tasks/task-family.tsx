import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { movedOrder, type PhysicalMove } from '#web-shared/ui/physical-drag.ts'
import { rankOf } from '#tasks/select.ts'
import { taskRollup } from './project-view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { expandedTaskWidth, SUBTASK_INDENT } from './project-layout.ts'

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
  cardWidths,
  preview,
  renderCard,
}: {
  card: Card
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  cardWidths: Record<string, number>
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
  ) => rankOf({ card: a }) - rankOf({ card: b }))
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
  const width = opened.length ? Math.max(...opened.map(item => expandedTaskWidth({
    card: item,
    widths: cardWidths,
  }))) : undefined
  const style = {
    width,
    '--subtask-indent': `${SUBTASK_INDENT}px`,
  } as CSSProperties
  const className = `task-family ${width ? 'family-open' : ''}`

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
        <div className="subtasks">
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
