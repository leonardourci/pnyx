import { observeElementOffset } from '@tanstack/react-virtual'
import { useLayoutEffect, useState, type RefObject } from 'react'

// Motion transforms must not change a virtual list's scroll anchor.
export function layoutOffset({
  element,
  horizontal,
}: {
  element: HTMLElement
  horizontal: boolean
}) {
  let offset = 0
  let parent: HTMLElement | null = element

  while (parent) {
    offset += horizontal ? parent.offsetLeft + (parent.offsetParent?.clientLeft ?? 0)
      : parent.offsetTop + (parent.offsetParent?.clientTop ?? 0)
    parent = parent.offsetParent as HTMLElement | null
  }

  return offset
}

export function useScrollOffset({
  element,
  scroll,
  horizontal = false,
}: {
  element: RefObject<HTMLElement | null>
  scroll: HTMLElement | null
  horizontal?: boolean
}) {
  const [
    margin,
    setMargin,
  ] = useState(0)
  useLayoutEffect(
    () => {
      const node = element.current

      if (!node || !scroll) {
        return
      }

      const measure = () => {
        const next = layoutOffset({
          element: node,
          horizontal,
        })
        - layoutOffset({
          element: scroll,
          horizontal,
        })
        setMargin(previous => previous === next ? previous : next)
      }

      const observer = new ResizeObserver(measure)
      const placement = new MutationObserver(measure)
      measure()

      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
        observer.observe(parent)
        placement.observe(
          parent,
          { childList: true },
        )

        for (const sibling of parent.children) {
          observer.observe(sibling)
        }

        if (parent === scroll) {
          break
        }
      }

      return () => {
        observer.disconnect()
        placement.disconnect()
      }
    },
    [
      element,
      scroll,
      horizontal,
    ],
  )

  return margin
}

// eslint-disable-next-line pnyx/object-params -- TanStack owns observer callback signatures.
export const observeCurrentScroll: typeof observeElementOffset = (
  instance,
  changed,
) => {
  const stop = observeElementOffset(
    instance,
    changed,
  )
  const element = instance.scrollElement
  changed(
    (instance.options.horizontal ? element?.scrollLeft : element?.scrollTop) ?? 0,
    false,
  )

  return stop
}

// A drop lands at the layout position while Motion finishes moving the visible card.
export function layoutBox({ element }: { element: HTMLElement }) {
  let left = layoutOffset({
    element,
    horizontal: true,
  })
  let top = layoutOffset({
    element,
    horizontal: false,
  })

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    left -= parent.scrollLeft
    top -= parent.scrollTop
  }

  return {
    left,
    top,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }
}
