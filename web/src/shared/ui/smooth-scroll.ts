import { useEffect, useRef, type RefObject } from 'react'
import Lenis, { type VirtualScrollData } from 'lenis'
import Snap from 'lenis/snap'
import { phoneLayout } from '#web-shared/card-sizing.ts'

const SCROLL_IDLE_MS = 500
const SCROLL_LERP = 0.12

const scrolls = new Set<Lenis>()
let scrollFrame: number | undefined

// eslint-disable-next-line othrys/object-params -- requestAnimationFrame supplies its timestamp.
function advanceScroll(time: number) {
  scrollFrame = undefined
  scrolls.forEach(lenis => lenis.raf(time))

  if (scrolls.size) {
    scrollFrame = requestAnimationFrame(advanceScroll)
  }
}

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
  const controller = useRef<Lenis | null>(null)
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
        virtualScroll: ({
          deltaX,
          deltaY,
        }) => !horizontal
          || !phoneLayout({ width: innerWidth }) && Math.abs(deltaX) > Math.abs(deltaY),
        smoothWheel: true,
        autoRaf: false,
        lerp: SCROLL_LERP,
        allowNestedScroll: true,
        respectReducedMotion: true,
      })
      controller.current = lenis
      scrolls.add(lenis)

      if (scrollFrame === undefined) {
        scrollFrame = requestAnimationFrame(advanceScroll)
      }

      const snap = horizontal ? new Snap(
        lenis,
        {
          type: 'proximity',
          debounce: SCROLL_IDLE_MS,
          distanceThreshold: '20%',
        },
      ) : undefined

      const settledSnap = ({ event }: VirtualScrollData) => {
        if (phoneLayout({ width: innerWidth })) {
          return
        }

        snap?.onSnapDebounced({
          event,
          deltaX: 0,
          deltaY: 0,
        })
      }

      if (snap) {
        lenis.off(
          'virtual-scroll',
          snap.onSnapDebounced,
        )
        lenis.on(
          'virtual-scroll',
          settledSnap,
        )
      }

      let removeSnaps: (() => void)[] = []

      const resize = () => {
        lenis.resize()
        removeSnaps.forEach(remove => remove())
        const padding = parseFloat(getComputedStyle(wrapper).scrollPaddingLeft) || 0
        removeSnaps = snap ? [...wrapper.querySelectorAll<HTMLElement>('[data-titan-workspace]')]
          .map(element => snap.add(Math.max(
            0,
            element.offsetLeft + inner.offsetLeft - wrapper.offsetLeft - padding,
          ))) : []
      }

      resize()
      const sizes = new ResizeObserver(resize)
      // Lenis measures wrapper resizes; this observer refreshes snap coordinates when content changes.
      sizes.observe(inner)

      const surface = wrapper.closest<HTMLElement>('.workspace-axis') ?? wrapper

      const syncScrolling = () => {
        if (surface.dataset.dragging || surface.dataset.page === 'settings') {
          lenis.stop()
        } else {
          lenis.start()
        }
      }

      syncScrolling()
      const observer = new MutationObserver(syncScrolling)
      observer.observe(
        surface,
        {
          attributes: true,
          attributeFilter: [
            'data-dragging',
            'data-page',
          ],
        },
      )

      return () => {
        controller.current = null
        observer.disconnect(); sizes.disconnect(); removeSnaps.forEach(remove => remove())
        scrolls.delete(lenis)

        if (!scrolls.size && scrollFrame !== undefined) {
          cancelAnimationFrame(scrollFrame)
          scrollFrame = undefined
        }

        lenis.off(
          'virtual-scroll',
          settledSnap,
        )
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

  return controller
}
