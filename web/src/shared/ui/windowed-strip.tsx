import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useScrollOffset, observeCurrentScroll } from './scroll-offset.ts'

export function WindowedStrip<T>({
  items,
  itemKey,
  size,
  render,
  scroll,
  gap,
  protectedItems,
  reveal,
  revealKey,
  padding,
}: {
  items: T[]
  itemKey({ item }: { item: T }): string
  size({ item }: { item: T }): number
  render({ item }: { item: T }): ReactNode
  scroll: HTMLElement | null
  gap: number
  protectedItems: Set<string>
  reveal?: string | null
  revealKey?: string
  padding: number
}) {
  const element = useRef<HTMLDivElement>(null)
  const margin = useScrollOffset({
    element,
    scroll,
    horizontal: true,
  })
  const virtual = useVirtualizer({
    horizontal: true,
    scrollPaddingStart: padding,
    scrollPaddingEnd: padding,
    // The shared scroller owns restoration; mounting an inner window must not reset it.
    scrollToFn: () => undefined,
    observeElementOffset: observeCurrentScroll,
    count: items.length,
    getScrollElement: () => scroll,
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    getItemKey: index => itemKey({ item: items[index]! }),
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    estimateSize: index => size({ item: items[index]! }),
    gap,
    scrollMargin: margin,
    overscan: 0,
    // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
    rangeExtractor: range => [
      ...new Set([
        ...defaultRangeExtractor(range),
        ...items.flatMap((
          item,
          index,
        ) => protectedItems.has(itemKey({ item })) ? [index] : []),
      ]),
    ].sort((
      a,
      b,
    ) => a - b),
    useAnimationFrameWithResizeObserver: true,
  })
  const signature = items.map(item => `${itemKey({ item })}:${size({ item })}`).join('|')
  useLayoutEffect(
    () => virtual.measure(),
    [signature],
  )
  useLayoutEffect(
    () => {
      const index = items.findIndex(item => itemKey({ item }) === reveal)

      if (index >= 0) {
        const offset = virtual.getOffsetForIndex(
          index,
          'start',
        )?.[0]

        if (offset !== undefined) {
          scroll?.scrollTo({
            left: offset,
            behavior: 'instant',
          })
        }
      }
    },
    [
      reveal,
      revealKey,
      signature,
      margin,
    ],
  )

  const offset = virtual.scrollOffset ?? 0
  const viewportWidth = virtual.scrollRect?.width ?? 0
  const visible = virtual.getVirtualItems().filter(item =>
    protectedItems.has(itemKey({ item: items[item.index]! }))
    || item.end > offset && item.start < offset + viewportWidth)

  return (
    <div
      ref={element}
      data-scroll-content
      data-scroll-margin={margin}
      data-scroll-offset={virtual.scrollOffset}
      className="relative h-full flex-none"
      style={{ width: virtual.getTotalSize() }}
    >
      {visible.map(item => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtual.measureElement}
          className="absolute top-0 h-full w-max"
          style={{ left: item.start - margin }}
        >{render({ item: items[item.index]! })}
        </div>
      ))}
    </div>
  )
}
