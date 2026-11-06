import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export function useAutoHeight({
  input,
  mirror,
  display,
  afterFit,
}: {
  input: RefObject<HTMLTextAreaElement | null>
  mirror: RefObject<HTMLDivElement | null>
  display: string
  afterFit({ element }: { element: HTMLTextAreaElement }): void
}) {
  const fittedHeight = useRef<string | undefined>(undefined)

  // Holding the box height while measuring stops the browser from scrolling a pinned chat up.
  const fit = ({ element }: { element: HTMLTextAreaElement }) => {
    if (fittedHeight.current !== undefined && element.style.height !== fittedHeight.current) {
      return
    }

    const box = element.parentElement

    if (box) {
      box.style.minHeight = `${box.offsetHeight}px`
    }

    element.style.height = '0'
    element.style.height = `${element.scrollHeight}px`
    fittedHeight.current = element.style.height
    box?.style.removeProperty('min-height')
  }

  useLayoutEffect(
    () => {
      const element = input.current

      if (!element) {
        return
      }

      fit({ element })

      afterFit({ element })
    },
    [display],
  )

  // A wider or narrower panel re-wraps the draft; only a width change refits, so the refit's own height change does not loop.
  useEffect(
    () => {
      const element = input.current

      if (!element) {
        return
      }

      let width = element.clientWidth
      const observer = new ResizeObserver(() => {
        if (element.clientWidth !== width) {
          width = element.clientWidth
          fit({ element })

          if (mirror.current) {
            mirror.current.scrollTop = element.scrollTop
          }
        }
      })
      observer.observe(element)

      return () => observer.disconnect()
    },
    [],
  )
}
