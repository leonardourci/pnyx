import { createContext, useContext, useCallback, useMemo, type ComponentProps, type RefCallback } from 'react'
import { useSortItem, useDropZone, useSortState, nestingRefusal, type SortItem } from '#web-shared/ui/sortable.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { AnimatedCardShell } from './card-shell.tsx'

type DragHandle = Pick<ReturnType<typeof useSortItem>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>
const Context = createContext<DragHandle | null>(null)

export function TaskDragHandle({...props}: ComponentProps<typeof IconButton>) {
  const drag = useContext(Context)!

  return (
    <IconButton
      {...drag.attributes}
      {...drag.listeners}
      {...props}
      ref={drag.setActivatorNodeRef}
      data-drag-handle
    />
  )
}

export function TaskCardDrag({
  item,
  disabled,
  modal,
  elementRef,
  ...props
}: Omit<ComponentProps<typeof AnimatedCardShell>, 'ref'> & {
  item: SortItem
  disabled: Parameters<typeof useSortItem>[0]['disabled']
  modal: boolean
  elementRef: RefCallback<HTMLElement>
}) {
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
      hoverNode(modal ? null : node)
      const wrapper = item.parent ? '[data-child]' : '[data-family]'
      sortableNode(modal ? null : node?.closest<HTMLElement>(wrapper) ?? node)
    },
    [
      elementRef,
      hoverNode,
      sortableNode,
      item.parent,
      modal,
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

  return (
    <Context value={handle}>
      <AnimatedCardShell
        {...props}
        ref={attach}
        data-sort-key={sort.key}
        nesting={nesting}
        // eslint-disable-next-line pnyx/object-params -- React supplies the pointer event.
        onPointerDown={event => {
          const target = event.target
          const header = target instanceof Element && target.closest('[data-card-header], [data-drag-handle]')

          if (!modal && (!props.selected || header)) {
            sort.pointerDown?.(event)
          }
        }}
      />
    </Context>
  )
}
