import { createContext, useContext, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type PointerEventHandler } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Active,
  type DropAnimationFunction,
  type KeyboardCoordinateGetter,
  type DropAnimation,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { animate, useReducedMotion } from 'motion/react'
import { DragPreview, dragSnapshot } from './drag-preview.tsx'
import { HOVER_CLAIM } from './tooltip.tsx'

const ACTIVATION_DISTANCE = 6
const DRAG_EDGE_THRESHOLD = {
  x: 0.02,
  y: 0.08,
}
const NEST_DROP_SECONDS = 0.26
const NEST_DROP_SCALE = 0.12
const DROP_DURATION = 220
const DROP_EASING = 'cubic-bezier(.22,1,.36,1)'

export interface SortMove {
  id: string
  over: string
  kind: SortItem['kind']
  scope: string
  targetScope: string
  hydra: string
  before: boolean
  nest: boolean
}

export interface SortItem {
  id: string
  kind: 'hydra' | 'project' | 'task'
  scope: string
  hydra: string
  parent?: string
  hasChildren?: boolean
  column?: string
  zone?: 'nest'
  overlay?: ReactNode
}

const DragState = createContext<{
  active: SortItem | null
  over: SortItem | null
  shift: boolean
}>({
  active: null,
  over: null,
  shift: false,
})
const Group = createContext({
  id: '',
  namespace: '',
})
const itemKey = ({
  group,
  id,
}: {
  group: string
  id: string
}) => `${group}:${id}`

export function movedOrder<T>({
  items,
  id,
  over,
  before,
  key,
}: {
  items: T[]
  id: string
  over: string
  before: boolean
  key({ item }: { item: T }): string
}) {
  const from = items.findIndex(item => key({ item }) === id)
  const target = items.findIndex(item => key({ item }) === over)

  if (from < 0 || target < 0 || from === target) {
    return items
  }

  const to = target + (before ? 0 : 1) - (from < target ? 1 : 0)

  return arrayMove(
    items,
    from,
    to,
  )
}

export function SortGroup({
  id,
  items,
  children,
  namespace = id,
}: {
  namespace?: string
  id: string
  items: string[]
  children: ReactNode
}) {
  const group = useMemo(
    () => ({
      id,
      namespace,
    }),
    [
      id,
      namespace,
    ],
  )

  return (
    <Group value={group}>
      <SortableContext
        id={id}
        items={items.map(item => itemKey({
          group: namespace,
          id: item,
        }))}
      >
        {children}
      </SortableContext>
    </Group>
  )
}

export function useSortState() {
  return useContext(DragState)
}

export function useSortItem({
  item,
  disabled = false,
}: {
  item: SortItem
  disabled?: Parameters<typeof useSortable>[0]['disabled']
}) {
  const group = useContext(Group)

  const key = itemKey({
    group: group.namespace,
    id: item.id,
  })
  const sortable = useSortable({
    id: key,
    data: { item },
    disabled,
    transition: null,
    animateLayoutChanges: () => false,
  })

  return {
    ...sortable,
    key,
    pointerDown: sortable.listeners?.onPointerDown as PointerEventHandler<HTMLElement> | undefined,
  }
}

export function useDropZone({
  item,
  disabled = false,
}: {
  item: SortItem
  disabled?: boolean
}) {
  return useDroppable({
    id: `${item.hydra}:${item.zone}:${item.id}`,
    data: { item },
    disabled,
  })
}

const itemOf = ({ data }: {
  data: { current?: { item?: SortItem } } | undefined
}): SortItem | undefined => data?.current?.item

function dropTargets({
  active,
  containers,
  nesting,
}: {
  active: Active
  containers: Parameters<CollisionDetection>[0]['droppableContainers']
  nesting: boolean
}) {
  const source = itemOf({ data: active.data })

  if (!source) {
    return []
  }

  return containers.filter(container => {
    const target = itemOf({ data: container.data })
    const sameHydra = source.kind === 'hydra' || target?.hydra === source.hydra

    if (!target || target.kind !== source.kind || !sameHydra) {
      return false
    }

    if (nesting) {
      return target.zone === 'nest' && !source.hasChildren && source.id !== target.id
    }

    const group = active.data.current?.sortable?.containerId

    return !target.zone && container.data.current?.sortable?.containerId === group
      && source.scope === target.scope
  })
}

// eslint-disable-next-line pnyx/object-params -- dnd-kit owns coordinate getter signatures.
const keyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  args,
) => {
  const active = args.context.active

  if (!active) {
    return undefined
  }

  const source = itemOf({ data: active.data })
  const targets = dropTargets({
    active,
    containers: args.context.droppableContainers.getEnabled(),
    nesting: source?.kind === 'task' && event.shiftKey,
  })
  const ids = new Set(targets.map(target => target.id))
  const droppableRects = new Map([...args.context.droppableRects].filter(([id]) => ids.has(id)))

  return sortableKeyboardCoordinates(
    event,
    {
      ...args,
      context: {
        ...args.context,
        droppableRects,
      },
    },
  )
}

function collisions({
  args,
  nesting,
}: {
  args: Parameters<CollisionDetection>[0]
  nesting: boolean
}) {
  const containers = dropTargets({
    active: args.active,
    containers: args.droppableContainers,
    nesting,
  })

  if (args.pointerCoordinates) {
    const {
      x,
      y,
    } = args.pointerCoordinates
    const pointed = document.elementFromPoint(
      x,
      y,
    )

    if (nesting) {
      const card = pointed?.closest('.card[data-task]')
      const target = containers.find(container => container.node.current === card)

      return target ? [{ id: target.id }] : []
    }

    const node = document.querySelector(`[data-sort-key="${CSS.escape(String(args.active.id))}"]`)
    const surface = node?.closest('[data-sort-surface]')

    if (!surface?.contains(pointed)) {
      return []
    }

    const targets = pointerWithin({
      ...args,
      droppableContainers: containers,
    })

    return targets.length ? targets : [{ id: args.active.id }]
  }

  return closestCenter({
    ...args,
    droppableContainers: containers,
  })
}

class WorkspacePointerSensor extends PointerSensor {
  static activators: typeof PointerSensor.activators = [
    {
      eventName: 'onPointerDown',
      // eslint-disable-next-line pnyx/object-params -- dnd-kit owns sensor activator signatures.
      handler: (
        event,
        options,
      ) => {
        const target = event.target
        const control = target instanceof Element ? target.closest('button,input,textarea,select,a,.resize,[contenteditable=true]') : null

        if (control && !control.matches('[data-drag-handle],[data-column-heading],[data-sort-id]')) {
          return false
        }

        return PointerSensor.activators[0]!.handler(
          event,
          options,
        )
      },
    },
  ]
}

export function DragNestHint() {
  const { shift } = useSortState()

  return <span data-drag-nest-hint data-shift={shift} className="inline-flex max-w-full items-center whitespace-nowrap rounded border border-line bg-surface px-1.5 py-0.5 text-meta font-medium text-muted transition-colors data-[shift=true]:border-gold-line data-[shift=true]:bg-gold-wash data-[shift=true]:text-gold">⇧ Sub-task</span>
}

export function SortableWorkspace({
  root,
  move,
  drop,
  children,
}: {
  root: RefObject<HTMLElement | null>
  move({ preview }: { preview: SortMove | null }): void
  drop({ preview }: { preview: SortMove }): void
  children: ReactNode
}) {
  const [
    active,
    setActive,
  ] = useState<SortItem | null>(null)
  const [
    over,
    setOver,
  ] = useState<SortItem | null>(null)
  const [
    snapshot,
    setSnapshot,
  ] = useState<HTMLElement | null>(null)
  const [
    shift,
    setShift,
  ] = useState(false)
  const modifier = useRef(false)
  const plain = useRef<SortMove | null>(null)
  const latestDetection = useRef<Parameters<CollisionDetection>[0] | null>(null)
  const detection = useRef<{
    x: number
    y: number
    nesting: boolean
    hits: ReturnType<CollisionDetection>
  } | null>(null)
  const nestingDrop = useRef<{
    parent: string
    hydra: string
  } | null>(null)
  const reducedMotion = useReducedMotion()
  const sensors = useSensors(
    useSensor(
      WorkspacePointerSensor,
      { activationConstraint: { distance: ACTIVATION_DISTANCE } },
    ),
    useSensor(
      KeyboardSensor,
      {
        coordinateGetter: keyboardCoordinates,
        keyboardCodes: {
          start: ['Space'],
          end: [
            'Space',
            'Enter',
          ],
          cancel: ['Escape'],
        },
      },
    ),
  )
  const setModifier = useCallback(
    ({ pressed }: { pressed: boolean }) => {
      modifier.current = pressed
      setShift(pressed)
    },
    [],
  )

  useLayoutEffect(
    () => {
      if (!active) {
        return
      }

      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault()
        }

        if (event.key === 'Shift') {
          setModifier({ pressed: event.shiftKey })
        }
      }

      const blur = () => setModifier({ pressed: false })
      window.addEventListener(
        'keydown',
        key,
        true,
      )
      window.addEventListener(
        'keyup',
        key,
        true,
      )
      window.addEventListener(
        'blur',
        blur,
      )

      return () => {
        window.removeEventListener(
          'keydown',
          key,
          true,
        )
        window.removeEventListener(
          'keyup',
          key,
          true,
        )
        window.removeEventListener(
          'blur',
          blur,
        )
      }
    },
    [
      active,
      setModifier,
    ],
  )

  // eslint-disable-next-line pnyx/object-params -- dnd-kit supplies the collision arguments.
  const detect: CollisionDetection = args => {
    latestDetection.current = args
    const source = itemOf({ data: args.active.data })

    const nesting = source?.kind === 'task' && modifier.current
    const pointer = args.pointerCoordinates
    const previous = detection.current

    if (pointer && previous?.x === pointer.x && previous.y === pointer.y
      && previous.nesting === nesting) {
      return previous.hits
    }

    const hits = collisions({
      args,
      nesting,
    })

    if (pointer) {
      detection.current = {
        ...pointer,
        nesting,
        hits,
      }
    }

    return hits
  }

  const clear = () => {
    plain.current = null
    latestDetection.current = null
    detection.current = null
    move({ preview: null })
    setActive(null)
    setOver(null)
    setSnapshot(null)
    setModifier({ pressed: false })

    if (root.current) {
      delete root.current.dataset.dragging
    }
  }

  const start = ({
    active,
    activatorEvent,
  }: DragStartEvent) => {
    const item = itemOf({ data: active.data })

    if (!item) {
      return
    }

    const node = document.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(String(active.id))}"]`)

    if (node && item.kind !== 'task') {
      setSnapshot(dragSnapshot({ element: node }))
    }

    if (root.current) {
      root.current.dataset.dragging = item.kind
    }

    const shifted = 'shiftKey' in activatorEvent && activatorEvent.shiftKey === true
    setModifier({ pressed: item.kind === 'task' && shifted })
    plain.current = null
    nestingDrop.current = null
    document.dispatchEvent(new CustomEvent(
      HOVER_CLAIM,
      {
        detail: {
          id: String(active.id),
          anchor: node,
        },
      },
    ))
    setActive({
      ...item,
      column: node?.closest<HTMLElement>('.project-column')?.dataset.column,
    })
  }

  const placement = ({
    active,
    target,
    targetKey,
    targetIndex,
  }: {
    active: Active
    target?: SortItem
    targetKey?: string | number
    targetIndex?: number
  }): SortMove | null => {
    const source = itemOf({ data: active.data })

    if (!source || !target) {
      return null
    }

    const nesting = source.kind === 'task' && modifier.current

    if (nesting && (target.zone !== 'nest' || source.hasChildren || source.parent === target.id)) {
      return null
    }

    if (!nesting && (target.zone || active.id === targetKey)) {
      return plain.current
    }

    let before = false

    if (!nesting) {
      const sourceIndex = active.data.current?.sortable?.index

      if (typeof sourceIndex !== 'number' || targetIndex === undefined) {
        return null
      }

      before = sourceIndex > targetIndex
    }

    return {
      id: source.id,
      over: target.id,
      kind: source.kind,
      scope: source.scope,
      targetScope: target.scope,
      hydra: source.hydra,
      before,
      nest: nesting,
    }
  }

  const hover = ({
    active,
    over,
  }: DragOverEvent) => {
    const target = over ? itemOf({ data: over.data }) : undefined
    setOver(target ?? null)

    if (!modifier.current || itemOf({ data: active.data })?.kind !== 'task') {
      plain.current = placement({
        active,
        target,
        targetKey: over?.id,
        targetIndex: over?.data.current?.sortable?.index,
      })
    }

    move({ preview: plain.current })
  }

  const finish = ({ active }: DragEndEvent) => {
    const args = latestDetection.current
    const source = itemOf({ data: active.data })
    const nesting = source?.kind === 'task' && modifier.current
    const hits = args ? collisions({
      args,
      nesting,
    }) : []
    const target = args?.droppableContainers.find(container => container.id === hits[0]?.id)
    let next = hits.length ? plain.current : null

    if (nesting) {
      next = placement({
        active,
        target: itemOf({ data: target?.data }),
        targetKey: target?.id,
        targetIndex: target?.data.current?.sortable?.index,
      })
    }

    if (next) {
      if (next.nest && !reducedMotion) {
        nestingDrop.current = {
          parent: next.over,
          hydra: next.hydra,
        }
      }

      drop({ preview: next })
    }

    clear()
  }

  const nestDrop: DropAnimationFunction = async ({
    active,
    dragOverlay,
    ...rest
  }) => {
    const destination = nestingDrop.current

    if (!destination) {
      return
    }

    const scope = root.current?.querySelector(`[data-hydra-workspace="${CSS.escape(destination.hydra)}"]`)
    const parent = scope?.querySelector<HTMLElement>(`[data-task="${CSS.escape(destination.parent)}"]`)
    const ghost = dragOverlay.node.querySelector<HTMLElement>('.physical-ghost')

    if (!parent || !ghost) {
      return
    }

    const from = ghost.getBoundingClientRect(), to = parent.getBoundingClientRect()
    const restore = defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } })({
      active,
      dragOverlay,
      ...rest,
    })

    try {
      await animate(
        ghost,
        {
          x: to.left + to.width / 2 - from.left - from.width / 2,
          y: to.top + to.height / 2 - from.top - from.height / 2,
          scale: [
            1,
            NEST_DROP_SCALE,
          ],
          opacity: [
            1,
            0,
          ],
        },
        {
          duration: NEST_DROP_SECONDS,
          ease: 'easeOut',
        },
      ).finished
    } finally {
      restore?.()

      if (nestingDrop.current === destination) {
        nestingDrop.current = null
      }
    }
  }

  let dropAnimation: DropAnimation | null = {
    duration: DROP_DURATION,
    easing: DROP_EASING,
  }

  if (reducedMotion) {
    dropAnimation = null
  } else if (nestingDrop.current) {
    dropAnimation = nestDrop
  }

  return (
    <DndContext
      sensors={sensors}
      autoScroll={{ threshold: DRAG_EDGE_THRESHOLD }}
      collisionDetection={detect}
      onDragStart={start}
      onDragOver={hover}
      onDragEnd={finish}
      onDragCancel={clear}
    >
      <DragState
        value={{
          active,
          over,
          shift,
        }}
      >
        {children}
        {createPortal(
          <DragOverlay
            adjustScale={false}
            style={{ pointerEvents: 'none' }}
            zIndex={1000}
            dropAnimation={dropAnimation}
          >
            {active && (
              <div className={`physical-ghost w-full pointer-events-none select-none rounded-card shadow-window opacity-95 ${active.kind === 'task' ? 'overflow-visible' : 'h-full overflow-hidden'}`} inert>
                {snapshot ? <DragPreview snapshot={snapshot} /> : active.overlay}
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DragState>
    </DndContext>
  )
}
