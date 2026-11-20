import { ProjectTasks } from './project-tasks.tsx'
import { useFamilyFolds } from './task-view.ts'
import { useKept } from '#web-shared/stable.ts'
import { FoldContent } from '#web-shared/ui/fold-content.tsx'
import { SortablePanel } from '#web-shared/ui/sortable-panel.tsx'
import { useSortState, SortGroup } from '#web-shared/ui/sortable.tsx'
import { memo, useCallback, useEffect, useRef, type ReactNode, type ComponentProps } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { compareTasks, taskRollup } from './project-view.ts'
import type { ObservedStatus } from './observed-status.ts'
import { SUBTASK_INDENT } from './project-layout.ts'

function Subtasks({
  children,
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className="subtasks mt-1.75 flex flex-col gap-1.75 border-l border-line pl-subtask">{children}</div>
}

export interface FamilyCard {
  card: Card
  status: ObservedStatus
  progress?: string
  childrenOpen?: boolean
  hasChildren?: boolean
  toggleChildren?(): void
}

interface FamilyRenderer {
  renderCard({
    card,
    status,
    progress,
    hasChildren,
    childrenOpen,
    toggleChildren,
  }: FamilyCard): ReactNode
}

function FamilyTask({
  family,
  renderCard,
}: FamilyRenderer & { family: FamilyCard }) {
  const status = useKept({ value: family.status })

  return renderCard({
    ...family,
    status,
  })
}

const FamilyPanel = memo(SortablePanel)

function DraggableFamily({
  id,
  hydra,
  ...props
}: ComponentProps<typeof SortablePanel> & {
  id: string
  hydra: string
}) {
  const drag = useSortState()
  const lifted = drag.active?.kind === 'task' && drag.active.id === id
    && drag.active.hydra === hydra

  return <FamilyPanel {...props} lifted={lifted} />
}

export function TaskFamily({
  card,
  hydraId,
  state,
  actions,
  selected,
  width,
  scroll,
  reveal,
  preview,
  renderCard,
}: {
  card: Card
  hydraId: string
  state: HydraState
  actions: Record<string, CurrentAction>
  selected: string[]
  width: number
  scroll: HTMLElement | null
  reveal?: string | null
  preview: SortMove | null
} & FamilyRenderer) {
  const [
    folds,
    setFolds,
  ] = useFamilyFolds({ hydraId })
  const expanded = folds[card.id] ?? false
  const setExpanded = useCallback(
    ({ open }: { open: boolean }) => {
      // eslint-disable-next-line pnyx/object-params -- React owns functional state updaters.
      setFolds(current => ({
        ...current,
        [card.id]: open,
      }))
    },
    [
      card.id,
      setFolds,
    ],
  )
  const toggleChildren = useCallback(
    () => {
      // eslint-disable-next-line pnyx/object-params -- React owns functional state updaters.
      setFolds(current => ({
        ...current,
        [card.id]: !current[card.id],
      }))
    },
    [
      card.id,
      setFolds,
    ],
  )
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
  const shown = preview?.kind === 'task' && preview.hydra === hydraId
    && !preview.nest && preview.scope === preview.targetScope
    ? movedOrder({
      items: sorted,
      ...preview,
      key: ({ item }) => item.id,
    }) : sorted
  const previousCount = useRef(children.length)
  useEffect(
    () => {
      if (children.length > previousCount.current) {
        setExpanded({ open: true })
      }

      previousCount.current = children.length
    },
    [children.length],
  )
  const childSelected = children.some(child => selected.includes(child.id))
  const childrenOpen = expanded || childSelected || children.length > previousCount.current
  const familyOpen = selected.includes(card.id) || childrenOpen && children.length > 0
  const className = `task-family min-w-0 flex-task task-family-sizing ${familyOpen ? 'family-open basis-full' : ''}`

  return (
    <DraggableFamily
      id={card.id}
      hydra={hydraId}
      layout="position"
      className={className}
      data-family={card.id}
    >
      <FamilyTask
        renderCard={renderCard}
        family={{
          card,
          status,
          progress: children.length ? `${done}/${children.length}` : undefined,
          hasChildren: children.length > 0,
          childrenOpen,
          toggleChildren,
        }}
      />
      {children.length > 0 && (
        <FoldContent open={childrenOpen}>
          <Subtasks data-sort-surface={`children:${card.id}`}>
            <SortGroup namespace={`tasks:${hydraId}`} id={`children:${card.id}`} items={shown.map(child => child.id)}>
              <ProjectTasks
                items={shown.filter(child => !child.hidden || selected.includes(child.id))}
                state={state}
                actions={actions}
                selected={selected}
                column={`children:${card.id}`}
                hydra={hydraId}
                width={width - SUBTASK_INDENT}
                scroll={scroll}
                reveal={reveal}
                singleColumn
                render={({ card: child }) => (
                  <DraggableFamily
                    id={child.id}
                    hydra={hydraId}
                    layout="position"
                    key={child.key}
                    data-child={child.id}
                  >
                    <FamilyTask
                      renderCard={renderCard}
                      family={{
                        card: child,
                        hasChildren: children.some(part => part.parentId === child.id),
                        status: taskRollup({
                          state,
                          card: child,
                          actions,
                        }).status,
                      }}
                    />
                  </DraggableFamily>
                )}
              />
            </SortGroup>
          </Subtasks>
        </FoldContent>
      )}
    </DraggableFamily>
  )
}
