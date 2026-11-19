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
  const releasedReveal = useRef<{
    item: string
    key?: string
  } | null>(null)
  const index = items.findIndex(item => itemKey({ item }) === reveal)
  useLayoutEffect(
    () => {
      if (!reveal) {
        releasedReveal.current = null

        return
      }

      const released = releasedReveal.current

      if (released?.item === reveal && released.key === revealKey) {
        return
      }

      const content = element.current
      const target = content?.children[index]
      const scroller = scroll.current

      if (!content || !(target instanceof HTMLElement) || !scroller) {
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
        const scrollPaddingLeft = parseFloat(getComputedStyle(scroller).scrollPaddingLeft)
        const padding = Number.isNaN(scrollPaddingLeft) ? 0 : scrollPaddingLeft
        scroller.scrollTo({
          left: targetLeft - scrollerLeft - scroller.clientLeft - padding,
          behavior: 'instant',
        })
      }

      revealTarget()
      let revealedScrollLeft = scroller.scrollLeft

      const onScroll = () => {
        if (scroller.scrollLeft !== revealedScrollLeft) {
          releasedReveal.current = {
            item: reveal,
            key: revealKey,
          }
          stopFollowing()
        }
      }

      const observer = new ResizeObserver(() => {
        if (scroller.scrollLeft !== revealedScrollLeft) {
          onScroll()

          return
        }

        revealTarget()
        revealedScrollLeft = scroller.scrollLeft
      })

      const stopFollowing = () => {
        observer.disconnect()
        scroller.removeEventListener(
          'scroll',
          onScroll,
        )
      }

      scroller.addEventListener(
        'scroll',
        onScroll,
        { passive: true },
      )
      observer.observe(content)
      observer.observe(scroller)

      // Width changes before the target can cancel out and leave the strip's total width unchanged.
      for (const item of Array.from(content.children).slice(
        0,
        index + 1,
      )) {
        observer.observe(item)
      }

      return stopFollowing
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
