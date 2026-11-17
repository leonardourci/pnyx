import { SortablePanel } from '#web-shared/ui/sortable-panel.tsx'
import { CardShell, CardContent } from './card-shell.tsx'
import { useSortState, SortGroup } from '#web-shared/ui/sortable.tsx'
import { CardSummary, cardTint } from './card-summary.tsx'
import { taskProjectColumn } from './project-view.ts'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type ComponentProps } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { compareTasks, taskRollup } from './project-view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { CLOSED_CARD_MIN_WIDTH, SUBTASK_INDENT } from './project-layout.ts'

function Subtasks({
  children,
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className="subtasks mt-1.75 flex flex-col gap-1.75 border-l border-line pl-[calc(var(--subtask-indent)-1px)]">{children}</div>
}

export interface FamilyCard {
  card: Card
  status: ObservedStatus
  progress?: string
  dragChildren?: ReactNode
  childrenOpen?: boolean
  hasChildren?: boolean
  toggleChildren?(): void
}

export function TaskFamily({
  card,
  hydraId,
  state,
  actions,
  selected,
  preview,
  renderCard,
}: {
  card: Card
  hydraId: string
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  preview: SortMove | null
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
  const sorted = children.toSorted(compareTasks({
    state,
    actions,
  }))
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
  const drag = useSortState()
  const dragged = drag.active?.kind === 'task' && drag.active.id === card.id
  const className = `task-family min-w-0 flex-[1_1_var(--closed-card-min)] ${opened.length ? 'family-open basis-full' : ''}`

  return (
    <SortablePanel
      layout="position"
      className={className}
      style={style}
      data-family={card.id}
      lifted={dragged}
    >
      {renderCard({
        card,
        status,
        progress: children.length ? `${done}/${children.length}` : undefined,
        hasChildren: children.length > 0,
        dragChildren: childrenOpen && (
          <Subtasks style={style}>
            {shown.filter(child => !child.hidden || selected.includes(child.id)).map(child => (
              <CardShell
                key={child.key}
                tint={cardTint({
                  card: child,
                  colors: state.labelColors,
                })}
              >
                <CardContent>
                  <CardSummary
                    card={child}
                    status={taskRollup({
                      state,
                      card: child,
                      actions,
                    }).status}
                    now={Date.now()}
                    colors={state.labelColors}
                    legacyProject={taskProjectColumn({
                      state,
                      card: child,
                    }) === 'ideas'}
                  />
                </CardContent>
              </CardShell>
            ))}
          </Subtasks>
        ),
        childrenOpen,
        toggleChildren: () => setExpanded(value => !value),
      })}
      {children.length > 0 && childrenOpen && (
        <Subtasks data-sort-surface={`children:${card.id}`}>
          <SortGroup namespace={`tasks:${hydraId}`} id={`children:${card.id}`} items={shown.map(child => child.id)}>
            {shown.filter(child => !child.hidden || selected.includes(child.id)).map(child => (
              <SortablePanel
                layout="position"
                key={child.key}
                data-child={child.id}
                lifted={drag.active?.kind === 'task' && drag.active.id === child.id}
              >
                {renderCard({
                  card: child,
                  status: taskRollup({
                    state,
                    card: child,
                    actions,
                  }).status,
                })}
              </SortablePanel>
            ))}
          </SortGroup>
        </Subtasks>
      )}
    </SortablePanel>
  )
}
