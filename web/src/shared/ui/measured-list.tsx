import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const ESTIMATE = 96
const OVERSCAN = 6
const INITIAL_HEIGHT = 1200

export function MeasuredList<T>({
  items,
  itemKey,
  render,
  onEdge,
  stayAtTop = false,
}: {
  items: readonly T[]
  itemKey({ item }: { item: T }): string
  render({
    item,
    index,
  }: {
    item: T
    index: number
  }): ReactNode
  onEdge?({ edge }: { edge: 'start' | 'end' }): void | Promise<void>
  stayAtTop?: boolean
}) {
  const list = useRef<HTMLDivElement>(null)
  const [
    margin,
    setMargin,
  ] = useState(0)

  const getScrollElement = () => {
    for (let parent = list.current?.parentElement; parent; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY

      if (overflow === 'auto' || overflow === 'scroll') {
        return parent
      }
    }

    return document.documentElement
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    // eslint-disable-next-line pnyx/object-params -- TanStack owns this callback.
    getItemKey: index => itemKey({ item: items[index]! }),
    estimateSize: () => ESTIMATE,
    overscan: OVERSCAN,
    initialRect: {
      width: 0,
      height: INITIAL_HEIGHT,
    },
    scrollMargin: margin,
    // Measuring inside the ResizeObserver pass resizes the chat's own observed ancestors and loops that pass.
    useAnimationFrameWithResizeObserver: true,
    anchorTo: stayAtTop && (!list.current || getScrollElement().scrollTop === 0) ? 'start' : 'end',
  })
  useLayoutEffect(() => {
    const element = list.current

    if (element) {
      const scroller = getScrollElement()
      const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      setMargin(offset + scroller.scrollTop)
    }
  })
  const rows = virtualizer.getVirtualItems()
  const first = rows[0]?.index
  const last = rows.at(-1)?.index

  useEffect(
    () => {
      if (first === 0) {
        onEdge?.({ edge: 'start' })
      }

      if (last === items.length - 1) {
        onEdge?.({ edge: 'end' })
      }
    },
    [
      first,
      last,
      items.length,
    ],
  )

  return (
    <div
      ref={list}
      style={{
        height: virtualizer.getTotalSize(),
        position: 'relative',
      }}
    >
      {rows.map(row => (
        <div
          key={row.key}
          data-index={row.index}
          className="measured-row"
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${row.start - margin}px)`,
          }}
        >
          {render({
            item: items[row.index]!,
            index: row.index,
          })}
        </div>
      ))}
    </div>
  )
}
