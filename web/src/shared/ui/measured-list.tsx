import { layoutOffset } from './layout-geometry.ts'
import { useSessionViewResource, sessionViewKey } from '#web-app/session-view.ts'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const ESTIMATE = 96
const OVERSCAN = 6
const INITIAL_HEIGHT = 1200

export function MeasuredList<T>({
  items,
  identity,
  itemKey,
  render,
  onEdge,
  stayAtTop = false,
}: {
  items: readonly T[]
  identity: string
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

  const scroller = useRef<HTMLElement | null>(null)
  const atTop = useRef(true)
  const getScrollElement = useCallback(
    () => scroller.current,
    [],
  )
  useLayoutEffect(
    () => {
      const element = list.current
      let parent = element?.parentElement

      while (parent) {
        const overflow = getComputedStyle(parent).overflowY

        if (overflow === 'auto' || overflow === 'scroll') {
          break
        }

        parent = parent.parentElement
      }

      const target = parent ?? document.documentElement
      scroller.current = target

      const position = () => {
        atTop.current = target.scrollTop === 0
      }

      position()
      target.addEventListener(
        'scroll',
        position,
        { passive: true },
      )

      return () => target.removeEventListener(
        'scroll',
        position,
      )
    },
    [],
  )

  const measurements = useSessionViewResource<VirtualItem[]>({
    key: sessionViewKey({
      scope: 'list',
      id: identity,
      field: 'measurements',
    }),
    initial: [],
  })
  const virtualizer = useVirtualizer({
    initialMeasurementsCache: measurements.snapshot(),
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
    anchorTo: stayAtTop && atTop.current ? 'start' : 'end',
  })
  useLayoutEffect(
    () => {
      const element = list.current
      const target = scroller.current

      if (!element || !target) {
        return
      }

      const measure = () => {
        const next = layoutOffset({
          element,
          horizontal: false,
        }) - layoutOffset({
          element: target,
          horizontal: false,
        })
        setMargin(previous => previous === next ? previous : next)
      }

      measure()
      const observer = new ResizeObserver(measure)

      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        observer.observe(parent)

        if (parent === target) {
          break
        }
      }

      return () => observer.disconnect()
    },
    [],
  )
  useLayoutEffect(
    () => () => {
      measurements.remember({ value: virtualizer.takeSnapshot() })
      measurements.flush()
    },
    [
      measurements,
      virtualizer,
    ],
  )
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
      data-scroll-content
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
