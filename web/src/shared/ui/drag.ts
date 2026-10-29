import type { DragEvent } from 'react'

// Native drag and drop for ordered lists. Board cards and the Hydra list share it, so a change here reaches both.

export function draggableItem({
  type,
  id,
  enabled,
  skip,
}: {
  type: string
  id: string
  enabled: boolean
  // Controls inside the item that keep their own pointer behavior instead of starting a drag.
  skip?: string
}) {
  return {
    draggable: enabled,
    // eslint-disable-next-line pnyx/object-params -- React event handler.
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (skip && event.target instanceof Element && event.target.closest(skip)) {
        event.preventDefault()

        return
      }

      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(
        type,
        id,
      )
    },
  }
}

export const carries = ({
  event,
  type,
}: {
  event: DragEvent<HTMLElement>
  type: string
}) => event.dataTransfer.types.includes(type)

// The dragged id is readable only on drop; during dragover it is empty.
export function dropPoint({
  event,
  type,
  item,
}: {
  event: DragEvent<HTMLElement>
  type: string
  item: string
}) {
  const over = event.target instanceof Element ? event.target.closest<HTMLElement>(`[${item}]`) : null
  const rect = over?.getBoundingClientRect()

  return {
    dragged: event.dataTransfer.getData(type),
    over: over?.getAttribute(item) ?? undefined,
    below: !!rect && event.clientY > rect.top + rect.height / 2,
  }
}
