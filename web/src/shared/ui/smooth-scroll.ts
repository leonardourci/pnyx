import { useEffect, type RefObject } from 'react'
import Lenis from 'lenis'
import Snap from 'lenis/snap'

const SCROLL_LERP = 0.12

export const scrollBehavior = (): ScrollBehavior =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'

export function useSmoothScroll({
  root,
  content,
  horizontal = false,
  snapKey = '',
}: {
  root: RefObject<HTMLElement | null>
  content?: RefObject<HTMLElement | null>
  horizontal?: boolean
  snapKey?: string
}) {
  useEffect(
    () => {
      const wrapper = root.current
      const inner = content?.current ?? wrapper

      if (!wrapper || !inner) {
        return
      }

      const lenis = new Lenis({
        wrapper,
        content: inner,
        orientation: horizontal ? 'horizontal' : 'vertical',
        gestureOrientation: horizontal ? 'horizontal' : 'vertical',
        smoothWheel: true,
        autoRaf: true,
        lerp: SCROLL_LERP,
        allowNestedScroll: true,
        respectReducedMotion: true,
      })
      const snap = horizontal ? new Snap(
        lenis,
        {
          type: 'proximity',
          distanceThreshold: '20%',
        },
      ) : undefined
      let removeSnaps: (() => void)[] = []

      const resize = () => {
        lenis.resize()
        removeSnaps.forEach(remove => remove())
        const padding = parseFloat(getComputedStyle(wrapper).scrollPaddingLeft) || 0
        const left = wrapper.getBoundingClientRect().left
        removeSnaps = [...wrapper.querySelectorAll<HTMLElement>('[data-hydra-workspace]')]
          .flatMap(element => snap ? [
            snap.add(Math.max(
              0,
              element.getBoundingClientRect().left - left + wrapper.scrollLeft - padding,
            )),
          ] : [])
      }

      resize()
      const sizes = new ResizeObserver(resize)
      sizes.observe(inner)
      const observer = new MutationObserver(() => {
        if (wrapper.dataset.dragging) {
          lenis.stop()
        } else {
          lenis.start()
        }
      })
      observer.observe(
        wrapper,
        {
          attributes: true,
          attributeFilter: ['data-dragging'],
        },
      )

      return () => {
        observer.disconnect(); sizes.disconnect(); removeSnaps.forEach(remove => remove())
        snap?.destroy(); lenis.destroy()
      }
    },
    [
      root,
      content,
      horizontal,
      snapKey,
    ],
  )
}
