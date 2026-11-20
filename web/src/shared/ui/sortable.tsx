import { runtimeStyle, type RuntimeStyle } from './runtime-style.ts'
import { layoutBox } from './layout-box.ts'
import { useKept } from '#web-shared/stable.ts'
import { trackUIDrag } from '#web-app/ui-metrics.ts'
import { CARD_SIZING, WORKSPACE_SIZING, liftedCardSize } from '#web-shared/card-sizing.ts'
import { motionDuration, MOTION_EASING, MOTION_CSS_EASING } from '#web-shared/motion.ts'
import { createContext, useContext, useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type PointerEventHandler } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
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
  type DragMoveEvent,
  type DragStartEvent,
  type Active,
  type DropAnimationFunction,
  type KeyboardCoordinateGetter,
  type Modifier,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { motion, useAnimationControls, useReducedMotion } from 'motion/react'
import { DragPreview, dragSnapshot } from './drag-preview.tsx'
import { HOVER_CLAIM } from './tooltip.tsx'

const ACTIVATION_DISTANCE = 6
const DRAG_EDGE_THRESHOLD = {
  x: 0.02,
  y: 0.08,
}
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }

// eslint-disable-next-line pnyx/object-params -- dnd-kit supplies the activator event.
const dragTransition = (event: Event | null) => event instanceof KeyboardEvent
  ? `transform ${motionDuration()}ms ${MOTION_CSS_EASING}` : undefined

export interface SortMove {
  id: string
  over: string
  kind: SortItem['kind']
  scope: string
  targetScope: string
  hydra: string
  before: boolean
  nest: boolean
  outdent?: boolean
}

export interface SortItem {
  id: string
  kind: 'hydra' | 'project' | 'task'
  scope: string
  hydra: string
  parent?: string
  hasChildren?: boolean
  column?: string
  zone?: 'nest' | 'outdent'
  root?: {
    column: string
    scope: string
  }
  overlay?: ReactNode
  open?: boolean
  overlayStyle?: RuntimeStyle
  size?: {
    width: number
    height: number
  }
  origin?: {
    left: number
    top: number
  }
  compactSize?: {
    width: number
    height: number
  }
  grab?: {
    x: number
    y: number
    offsetX: number
    offsetY: number
  }
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

function grabPoint({
  event,
  box,
}: {
  event: Pick<PointerEvent, 'clientX' | 'clientY'>
  box: DOMRect
}) {
  return {
    x: Math.max(
      0,
      Math.min(
        1,
        (event.clientX - box.left) / box.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1,
        (event.clientY - box.top) / box.height,
      ),
    ),
  }
}

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

  const stableItems = useKept({ value: items })
  const keys = useMemo(
    () => stableItems.map(item => itemKey({
      group: namespace,
      id: item,
    })),
    [
      stableItems,
      namespace,
    ],
  )

  return (
    <Group value={group}>
      <SortableContext
        id={id}
        items={keys}
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
  const pickup = useRef<ReturnType<typeof grabPoint> | null>(null)

  const key = itemKey({
    group: group.namespace,
    id: item.id,
  })
  const sortable = useSortable({
    id: key,
    data: {
      item,
      pickup,
    },
    disabled,
    transition: null,
    animateLayoutChanges: () => false,
  })

  const activate = sortable.listeners?.onPointerDown as PointerEventHandler<HTMLElement> | undefined
  const capturePointerDown = useCallback<PointerEventHandler<HTMLElement>>(
    // eslint-disable-next-line pnyx/object-params -- React supplies the pointer event.
    event => {
      const element = event.currentTarget.closest<HTMLElement>('[data-sort-key]') ?? event.currentTarget
      pickup.current = grabPoint({
        event,
        box: element.getBoundingClientRect(),
      })
      activate?.(event)
    },
    [activate],
  )

  return {
    ...sortable,
    key,
    pointerDown: activate ? capturePointerDown : undefined,
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
  outdent = false,
}: {
  active: Active
  containers: Parameters<CollisionDetection>[0]['droppableContainers']
  nesting: boolean
  outdent?: boolean
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
      const lifting = outdent && target.zone === 'outdent' && !!source.parent

      return lifting || target.zone === 'nest' && source.id !== target.id
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
    outdent: true,
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
      const sourceNode = document.querySelector(`[data-sort-key="${CSS.escape(String(args.active.id))}"]`)
      const inOwnFamily = !!sourceNode?.closest('[data-family]')?.contains(pointed)
      const target = containers.find(container => card ? container.node.current === card
        : !inOwnFamily && container.data.current?.item?.zone === 'outdent' && !!container.node.current?.contains(pointed))

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
        const control = target instanceof Element ? target.closest('button,input,textarea,select,a,.resize,[contenteditable=true], [popover]') : null

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

export function nestingRefusal({
  source,
  target,
}: {
  source: SortItem
  target: SortItem
}) {
  if (target.zone === 'outdent') {
    return source.root?.column === target.id ? null : "Can't move to another project"
  }

  if (source.parent === target.id) {
    return null
  }

  if (source.hasChildren) {
    return "Can't nest: this task has its own sub-tasks"
  }

  if (target.parent) {
    return "Can't nest here: this task is already a sub-task"
  }

  return null
}

function DragNestHint() {
  const {
    active,
    over,
    shift,
  } = useSortState()
  const refusal = shift && active && over?.zone ? nestingRefusal({
    source: active,
    target: over,
  }) : null

  if (refusal) {
    return <span data-drag-nest-refusal className="inline-flex max-w-full rounded border border-line bg-surface px-1.5 py-0.5 text-meta font-medium text-muted">{refusal}</span>
  }

  if (active?.hasChildren) {
    return null
  }

  return <span data-drag-nest-hint data-shift={shift} className="inline-flex max-w-full items-center rounded border border-line bg-surface px-1.5 py-0.5 text-meta font-medium whitespace-nowrap text-muted transition-colors data-[shift=true]:border-gold-line data-[shift=true]:bg-gold-wash data-[shift=true]:text-gold">⇧ Sub-task</span>
}

function DragGhost({
  item,
  snapshot,
  compact,
}: {
  item: SortItem
  snapshot: HTMLElement | null
  compact: boolean
}) {
  const {
    active,
    over,
    shift,
  } = useSortState()
  const reducedMotion = useReducedMotion()
  const canNest = item.kind === 'task'
  const inside = canNest && shift && over?.zone === 'nest' && over.id !== item.parent
    && !nestingRefusal({
      source: item,
      target: over,
    })

  const size = compact || inside ? item.compactSize : item.size
  const initialSize = useRef(item.size).current
  const sizing = useAnimationControls()
  const duration = motionDuration({ reducedMotion: !!reducedMotion }) / 1000
  useLayoutEffect(
    () => {
      if (active && item.kind === 'task' && size) {
        void sizing.start(
          size,
          {
            duration,
            ease: MOTION_EASING,
          },
        )
      }
    },
    [
      active,
      item.kind,
      size,
      sizing,
      duration,
    ],
  )
  const anchor = item.kind === 'task' && item.grab ? `${-item.grab.x * 100}% ${-item.grab.y * 100}%` : undefined

  return (
    <motion.div
      initial={false}
      animate={sizing}
      data-grab-x={item.grab?.x ?? 0}
      data-grab-y={item.grab?.y ?? 0}
      style={runtimeStyle({
        width: item.kind === 'task' ? initialSize?.width : undefined,
        height: item.kind === 'task' ? initialSize?.height : undefined,
        ...item.overlayStyle,
        translate: anchor,
      })}
      className={`physical-ghost pointer-events-none relative w-full opacity-95 select-none ${item.kind === 'task' ? 'overflow-visible' : 'h-full overflow-hidden'}`}
      inert
    >
      <motion.div
        data-drag-preview
        style={runtimeStyle({ transformOrigin: item.grab ? `${item.grab.x * 100}% ${item.grab.y * 100}%` : undefined })}
        initial={false}
        animate={{ scale: inside ? CARD_SIZING.nest.hoverScale : 1 }}
        transition={{
          duration: motionDuration({
            speed: 'fast',
            reducedMotion: !!reducedMotion,
          }) / 1000,
        }}
        className="h-full rounded-card shadow-window"
      >
        {snapshot && (!compact || item.kind !== 'task') ? <DragPreview snapshot={snapshot} /> : item.overlay}
      </motion.div>
      {canNest && <div className="absolute -top-3 right-2"><DragNestHint /></div>}
    </motion.div>
  )
}

function landingAnchor({
  column,
  scope,
  id,
  pointer,
}: {
  column: Element
  scope: string
  id: string
  pointer: {
    x: number
    y: number
  }
}) {
  const cards = [...column.querySelectorAll<HTMLElement>(`.card[data-task][data-sort-scope="${CSS.escape(scope)}"]`)]
    .filter(card => card.dataset.task !== id)
    .map(card => ({
      id: card.dataset.task!,
      box: card.getBoundingClientRect(),
    }))
    .sort((
      a,
      b,
    ) => a.box.top - b.box.top || a.box.left - b.box.left)

  const isBefore = ({ box }: { box: DOMRect }) => {
    const aboveRow = pointer.y < box.top
    const leftInRow = pointer.y <= box.bottom && pointer.x < box.left + box.width / 2

    return aboveRow || leftInRow
  }

  const next = cards.find(isBefore)

  if (next) {
    return {
      id: next.id,
      before: true,
    }
  }

  const last = cards.at(-1)

  return last ? {
    id: last.id,
    before: false,
  } : null
}

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: ACTIVATION_DISTANCE } }
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: keyboardCoordinates,
  keyboardCodes: {
    start: ['Space'],
    end: [
      'Space',
      'Enter',
    ],
    cancel: ['Escape'],
  },
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
  ] = useState<(SortItem & { pointerDrag: boolean }) | null>(null)
  useEffect(
    () => active ? trackUIDrag({
      action: active.kind,
      hydraId: active.hydra,
    }) : undefined,
    [active],
  )

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
  const [
    compact,
    setCompact,
  ] = useState(false)
  const modifier = useRef(false)
  const plain = useRef<SortMove | null>(null)
  const latestDetection = useRef<Parameters<CollisionDetection>[0] | null>(null)
  const scrollGeneration = useRef(0)
  useEffect(
    () => {
      const surface = root.current

      const scrolled = () => {
        scrollGeneration.current += 1
      }

      surface?.addEventListener(
        'scroll',
        scrolled,
        true,
      )

      return () => surface?.removeEventListener(
        'scroll',
        scrolled,
        true,
      )
    },
    [root],
  )
  const detection = useRef<{
    x: number
    y: number
    nesting: boolean
    scroll: number
    hits: ReturnType<CollisionDetection>
  } | null>(null)
  const landingDrop = useRef<{
    task: string
    hydra: string
    nest: boolean
  } | null>(null)
  const reducedMotion = useReducedMotion()
  const sensors = useSensors(
    useSensor(
      WorkspacePointerSensor,
      POINTER_SENSOR_OPTIONS,
    ),
    useSensor(
      KeyboardSensor,
      KEYBOARD_SENSOR_OPTIONS,
    ),
  )
  const refreshTarget = useCallback(
    () => {
      detection.current = null
      const args = latestDetection.current

      if (args) {
        const hits = collisions({
          args,
          nesting: modifier.current && itemOf({ data: args.active.data })?.kind === 'task',
        })
        const target = args.droppableContainers.find(container => container.id === hits[0]?.id)
        setOver(itemOf({ data: target?.data }) ?? null)
      }
    },
    [],
  )

  const setModifier = useCallback(
    ({ pressed }: { pressed: boolean }) => {
      modifier.current = pressed
      setShift(pressed)
      refreshTarget()
    },
    [refreshTarget],
  )

  useLayoutEffect(
    () => {
      if (active?.kind !== 'task' || !active.pointerDrag || !shift) {
        return
      }

      // A reorder can slide a new target under a stationary pointer.
      let pointed: Element | null | undefined

      const refresh = () => {
        frame = requestAnimationFrame(refresh)
        const pointer = latestDetection.current?.pointerCoordinates

        if (!pointer) {
          return
        }

        const next = document.elementFromPoint(
          pointer.x,
          pointer.y,
        )

        if (next !== pointed) {
          pointed = next
          refreshTarget()
        }
      }

      let frame = requestAnimationFrame(refresh)

      return () => cancelAnimationFrame(frame)
    },
    [
      active,
      shift,
      refreshTarget,
    ],
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
    const scroll = scrollGeneration.current

    if (pointer && previous?.x === pointer.x && previous.y === pointer.y
      && previous.nesting === nesting && previous.scroll === scroll) {
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
        scroll,
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
    setCompact(false)
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

    if (node && (item.kind !== 'task' || item.open)) {
      setSnapshot(dragSnapshot({ element: node }))
    }

    if (root.current) {
      root.current.dataset.dragging = item.kind
    }

    const shifted = 'shiftKey' in activatorEvent && activatorEvent.shiftKey === true
    setModifier({ pressed: item.kind === 'task' && shifted })
    plain.current = null
    landingDrop.current = null
    document.dispatchEvent(new CustomEvent(
      HOVER_CLAIM,
      {
        detail: {
          id: String(active.id),
          anchor: node,
        },
      },
    ))
    const box = node?.getBoundingClientRect()
    const styles = node ? getComputedStyle(node) : null
    const grid = node?.closest<HTMLElement>('.project-card-grid')
    const gap = WORKSPACE_SIZING.cardGap
    const family = node?.closest<HTMLElement>('[data-family]')
    const indent = item.parent && family ? parseFloat(getComputedStyle(family).getPropertyValue('--subtask-indent')) : 0
    const size = box ? {
      width: box.width,
      height: box.height,
    } : undefined
    const compactSize = size && item.kind === 'task' ? liftedCardSize({
      size,
      columnWidth: grid?.getBoundingClientRect().width ?? size.width,
      gap,
      indent,
      open: item.open,
    }) : size
    let grab: SortItem['grab']

    const pointerDrag = activatorEvent instanceof PointerEvent

    if (box && pointerDrag) {
      const point: ReturnType<typeof grabPoint> = active.data.current?.pickup?.current
        ?? grabPoint({
          event: activatorEvent,
          box,
        })
      grab = {
        ...point,
        offsetX: activatorEvent.clientX - box.left,
        offsetY: activatorEvent.clientY - box.top,
      }
    }

    setActive({
      ...item,
      pointerDrag,
      grab,
      overlayStyle: {
        uiFont: styles?.getPropertyValue('--text-ui'),
        chatFont: styles?.getPropertyValue('--text-chat'),
        codeFont: styles?.getPropertyValue('--text-code'),
      },
      size,
      origin: box ? {
        left: box.left,
        top: box.top,
      } : undefined,
      compactSize,
      column: node?.closest<HTMLElement>('.project-column')?.dataset.column,
    })
  }

  const outdentPlacement = ({
    source,
    target,
  }: {
    source: SortItem
    target: SortItem
  }): SortMove | null => {
    const pointer = latestDetection.current?.pointerCoordinates
    const workspace = root.current?.querySelector(`[data-hydra-workspace="${CSS.escape(source.hydra)}"]`)
    const column = workspace?.querySelector(`[data-column="${CSS.escape(target.id)}"]`)

    if (!pointer || !column || !source.root || nestingRefusal({
      source,
      target,
    })) {
      return null
    }

    const anchor = landingAnchor({
      column,
      scope: source.root.scope,
      id: source.id,
      pointer,
    })

    return {
      id: source.id,
      over: anchor?.id ?? '',
      kind: source.kind,
      scope: source.scope,
      targetScope: target.id,
      hydra: source.hydra,
      before: anchor?.before ?? false,
      nest: false,
      outdent: true,
    }
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

    if (nesting && target.zone === 'outdent') {
      return outdentPlacement({
        source,
        target,
      })
    }

    if (nesting && (target.zone !== 'nest' || nestingRefusal({
      source,
      target,
    }) || source.parent === target.id)) {
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
      const lands = next.nest || next.outdent

      if (lands && !reducedMotion) {
        landingDrop.current = {
          task: next.nest ? next.over : next.id,
          hydra: next.hydra,
          nest: next.nest,
        }
      }

      drop({ preview: next })
    }

    clear()
  }

  const resizeLift = ({
    over,
    active: source,
  }: DragMoveEvent) => {
    if (active?.kind !== 'task') {
      return
    }

    const point = latestDetection.current?.pointerCoordinates
    const pointedColumn = point ? document.elementFromPoint(
      point.x,
      point.y,
    )?.closest<HTMLElement>('[data-column]') : null
    const anotherColumn = !!pointedColumn && pointedColumn.dataset.column !== active.column
    const target = over ? itemOf({ data: over.data }) : undefined
    const anotherSlot = !!target && target.id !== active.id
    const validNest = !!target?.zone && !nestingRefusal({
      source: active,
      target,
    }) && active.parent !== target.id

    if (anotherColumn || anotherSlot && (!modifier.current || validNest)) {
      setCompact(true)
    } else if (over?.id === source.id) {
      setCompact(false)
    }
  }

  const liftedPosition: Modifier = ({ transform }) => {
    if (active?.kind !== 'task' || !active.grab) {
      return transform
    }

    return {
      ...transform,
      x: transform.x + active.grab.offsetX,
      y: transform.y + active.grab.offsetY,
    }
  }

  const animateDrop: DropAnimationFunction = async ({
    active,
    dragOverlay,
    ...rest
  }) => {
    const landing = landingDrop.current
    const nest = !!landing?.nest

    const ghost = dragOverlay.node.querySelector<HTMLElement>('.physical-ghost')

    if (!ghost) {
      return
    }

    let landingCard = active.node.matches('.card') ? active.node : active.node.querySelector<HTMLElement>('.card[data-task]')

    if (landing) {
      const scope = root.current?.querySelector(`[data-hydra-workspace="${CSS.escape(landing.hydra)}"]`)
      landingCard = scope?.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(landing.task)}"]`) ?? null

      if (!landingCard) {
        return
      }
    }

    const to = landingCard ? layoutBox({ element: landingCard }) : active.rect
    const from = ghost.getBoundingClientRect()
    const grab = {
      x: Number(ghost.dataset.grabX),
      y: Number(ghost.dataset.grabY),
    }
    const x = to.left - from.left + (nest ? 0 : (to.width - from.width) * grab.x)
    const y = to.top - from.top + (nest ? 0 : (to.height - from.height) * grab.y)
    const centerX = x + (to.width - from.width * CARD_SIZING.nest.dropScale) / 2
    const centerY = y + (to.height - from.height * CARD_SIZING.nest.dropScale) / 2
    const restore = defaultDropAnimationSideEffects({ className: { active: 'opacity-0!' } })({
      active,
      dragOverlay,
      ...rest,
    })
    const hidden = landing && !nest ? landingCard : null

    if (hidden) {
      hidden.classList.add('opacity-0!')
    }

    const duration = motionDuration({ speed: nest ? 'slow' : 'base' })

    try {
      const end = nest ? {
        x: centerX,
        y: centerY,
        scale: CARD_SIZING.nest.dropScale,
        width: from.width,
        height: from.height,
        opacity: 0,
      } : {
        x,
        y,
        scale: 1,
        width: to.width,
        height: to.height,
        opacity: 1,
      }
      // A native animation, so the landing's own keyframes and timing can be read while it runs.
      await ghost.animate(
        [
          {
            transformOrigin: 'top left',
            transform: 'translate(0px, 0px) scale(1)',
            width: `${from.width}px`,
            height: `${from.height}px`,
            opacity: 1,
          },
          {
            transformOrigin: 'top left',
            transform: `translate(${end.x}px, ${end.y}px) scale(${end.scale})`,
            width: `${end.width}px`,
            height: `${end.height}px`,
            opacity: end.opacity,
          },
        ],
        {
          duration,
          easing: MOTION_CSS_EASING,
          fill: 'forwards',
        },
      ).finished

      if (duration > 0) {
        await new Promise(requestAnimationFrame)
      }
    } finally {
      restore?.()
      hidden?.classList.remove('opacity-0!')

      if (landingDrop.current === landing) {
        landingDrop.current = null
      }
    }
  }

  const dragState = useMemo(
    () => ({
      active,
      over,
      shift,
    }),
    [
      active,
      over,
      shift,
    ],
  )

  return (
    <DndContext
      sensors={sensors}
      measuring={MEASURING}
      autoScroll={{ threshold: DRAG_EDGE_THRESHOLD }}
      collisionDetection={detect}
      onDragStart={start}
      onDragOver={hover}
      onDragMove={resizeLift}
      onDragEnd={finish}
      onDragCancel={clear}
    >
      <DragState value={dragState}>
        {children}
        {createPortal(
          <DragOverlay
            adjustScale={false}
            className="pointer-events-none"
            transition={dragTransition}
            modifiers={[liftedPosition]}
            style={runtimeStyle({
              left: active?.origin?.left,
              top: active?.origin?.top,
              width: active?.kind === 'task' ? active.size?.width : undefined,
              height: active?.kind === 'task' ? active.size?.height : undefined,
            })}
            zIndex={1000}
            dropAnimation={reducedMotion ? null : animateDrop}
          >
            {active && (
              <DragGhost item={active} snapshot={snapshot} compact={compact} />
            )}
          </DragOverlay>,
          document.body,
        )}
      </DragState>
    </DndContext>
  )
}
