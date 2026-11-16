import { useEffect, type RefObject } from 'react'
import Lenis from 'lenis'
import Snap from 'lenis/snap'

const SCROLL_LERP = 0.12

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
        gestureOrientation: horizontal ? 'both' : 'vertical',
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
      snap?.addElements(
        [...wrapper.querySelectorAll<HTMLElement>('[data-hydra-workspace]')],
        { align: 'start' },
      )
      const sizes = new ResizeObserver(() => {
        lenis.resize(); snap?.resize()
      })
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
        observer.disconnect(); sizes.disconnect(); snap?.destroy(); lenis.destroy()
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
