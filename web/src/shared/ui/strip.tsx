import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { layoutOffset } from './layout-geometry.ts'

export function Strip<T>({
  items,
  itemKey,
  render,
  scroll,
  gap,
  reveal,
  revealKey,
}: {
  items: T[]
  itemKey({ item }: { item: T }): string
  render({ item }: { item: T }): ReactNode
  scroll: RefObject<HTMLElement | null>
  gap: number
  reveal?: string | null
  revealKey?: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const index = items.findIndex(item => itemKey({ item }) === reveal)
  useLayoutEffect(
    () => {
      const target = element.current?.children[index]
      const scroller = scroll.current

      if (!(target instanceof HTMLElement) || !scroller) {
        return
      }

      const revealTarget = () => {
        const targetLeft = layoutOffset({
          element: target,
          horizontal: true,
        })
        const scrollerLeft = layoutOffset({
          element: scroller,
          horizontal: true,
        })
        const padding = parseFloat(getComputedStyle(scroller).scrollPaddingLeft) || 0
        scroller.scrollTo({
          left: targetLeft - scrollerLeft - scroller.clientLeft - padding,
          behavior: 'instant',
        })
      }

      revealTarget()
      const observer = new ResizeObserver(revealTarget)
      observer.observe(element.current!)

      return () => observer.disconnect()
    },
    [
      index,
      reveal,
      revealKey,
      scroll,
    ],
  )

  return (
    <div
      ref={element}
      data-scroll-content
      className="relative flex h-full flex-none"
      style={{ gap }}
    >
      {items.map(item => <div key={itemKey({ item })} className="h-full w-max flex-none">{render({ item })}</div>)}
    </div>
  )
}
