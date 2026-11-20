import { useLayoutEffect, useState, type RefObject } from 'react'

export function useColumnHeight({
  element,
  active,
}: {
  element: RefObject<HTMLElement | null>
  active: boolean
}): number | undefined {
  const [
    height,
    setHeight,
  ] = useState<number>()
  useLayoutEffect(
    () => {
      const column = active ? element.current?.closest<HTMLElement>('.column-cards') : null

      if (!column) {
        return
      }

      const measure = () => {
        const css = getComputedStyle(column)
        setHeight(column.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom))
      }

      measure()
      const sizes = new ResizeObserver(measure)
      sizes.observe(column)

      return () => sizes.disconnect()
    },
    [
      element,
      active,
    ],
  )

  return height
}
