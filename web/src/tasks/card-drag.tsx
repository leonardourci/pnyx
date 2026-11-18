import { createContext, useContext, useCallback, useMemo, memo, type ComponentProps, type RefCallback, type PointerEvent } from 'react'
import { useSortItem, useDropZone, useSortState, nestingRefusal, type SortItem } from '#web-shared/ui/sortable.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { AnimatedCardShell } from './card-shell.tsx'

type DragHandle = Pick<ReturnType<typeof useSortItem>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>
const Context = createContext<DragHandle | null>(null)
const MemoCardShell = memo(AnimatedCardShell)

export function TaskDragHandle({...props}: ComponentProps<typeof IconButton>) {
  const drag = useContext(Context)

  return (
    <IconButton
      {...drag?.attributes}
      {...drag?.listeners}
      {...props}
      ref={drag?.setActivatorNodeRef}
      data-drag-handle
    />
  )
}

type TaskCardDragProps = Omit<ComponentProps<typeof AnimatedCardShell>, 'ref'> & {
  item: SortItem
  disabled: Parameters<typeof useSortItem>[0]['disabled']
  modal: boolean
  elementRef: RefCallback<HTMLElement>
}

export function TaskCardDrag({
  modal,
  elementRef,
  item,
  disabled,
  ...props
}: TaskCardDragProps) {
  if (modal) {
    return <AnimatedCardShell {...props} ref={elementRef} />
  }

  return (
    <SortableTaskCard
      {...props}
      elementRef={elementRef}
      item={item}
      disabled={disabled}
    />
  )
}

function SortableTaskCard({
  item,
  disabled,
  elementRef,
  ...props
}: Omit<TaskCardDragProps, 'modal'>) {
  const sort = useSortItem({
    item,
    disabled,
  })
  const hover = useDropZone({
    item: {
      ...item,
      zone: 'nest',
    },
    disabled: disabled === true || typeof disabled === 'object' && !!disabled.droppable,
  })
  const sortableNode = sort.setNodeRef
  const hoverNode = hover.setNodeRef
  const attach = useCallback(
    // eslint-disable-next-line pnyx/object-params -- React supplies the ref node.
    (node: HTMLElement | null) => {
      elementRef(node)
      hoverNode(node)
      const wrapper = item.parent ? '[data-child]' : '[data-family]'
      sortableNode(node?.closest<HTMLElement>(wrapper) ?? node)
    },
    [
      elementRef,
      hoverNode,
      sortableNode,
      item.parent,
    ],
  )
  const drag = useSortState()
  const nesting = drag.shift && drag.over?.zone === 'nest' && drag.over.id === item.id
    && drag.over.hydra === item.hydra && !!drag.active
    && !nestingRefusal({
      source: drag.active,
      target: drag.over,
    })
    && drag.active.parent !== item.id
  const handle = useMemo(
    () => ({
      attributes: sort.attributes,
      listeners: sort.listeners,
      setActivatorNodeRef: sort.setActivatorNodeRef,
    }),
    [
      sort.attributes,
      sort.listeners,
      sort.setActivatorNodeRef,
    ],
  )
  const pointerDown = sort.pointerDown
  const selected = props.selected
  const onPointerDown = useCallback(
    // eslint-disable-next-line pnyx/object-params -- React supplies the pointer event.
    (event: PointerEvent<HTMLElement>) => {
      const target = event.target
      const header = target instanceof Element && target.closest('[data-card-header], [data-drag-handle]')

      if (!selected || header) {
        pointerDown?.(event)
      }
    },
    [
      selected,
      pointerDown,
    ],
  )

  return (
    <Context value={handle}>
      <MemoCardShell
        {...props}
        ref={attach}
        data-sort-key={sort.key}
        nesting={nesting}
        onPointerDown={onPointerDown}
      />
    </Context>
  )
}
