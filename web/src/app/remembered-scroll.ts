import { useLayoutEffect, useState } from 'react'
import { useSessionViewResource } from './session-view.ts'

export interface ScrollPosition {
  left: number
  top: number
}

export function useRememberedScroll({
  key,
  active = true,
  initial = {
    left: 0,
    top: 0,
  },
}: {
  key: string
  active?: boolean
  initial?: ScrollPosition
}) {
  const view = useSessionViewResource({
    key,
    initial,
  })
  const [
    element,
    ref,
  ] = useState<HTMLElement | null>(null)
  useLayoutEffect(
    () => {
      if (!element || !active) {
        return
      }

      let restoring = true
      const desired = view.snapshot()
      const sizes = new ResizeObserver(() => restore())
      const additions = new MutationObserver(() => {
        watchContent()
        restore()
      })

      const watchContent = () => {
        sizes.observe(element)
        element.querySelectorAll('[data-scroll-content]').forEach(child => sizes.observe(child))

        for (const child of element.children) {
          sizes.observe(child)
        }
      }

      const stopRestoring = () => {
        restoring = false
        sizes.disconnect()
        additions.disconnect()
      }

      const restore = () => {
        if (!restoring) {
          return
        }

        element.scrollTo({
          ...desired,
          behavior: 'instant',
        })

        const restored = Math.abs(element.scrollTop - desired.top) < 1
          && Math.abs(element.scrollLeft - desired.left) < 1

        if (restored) {
          stopRestoring()
        }
      }

      const remember = () => {
        if (!restoring && !element.closest('[data-fold-open=false]')) {
          view.remember({
            value: {
              left: element.scrollLeft,
              top: element.scrollTop,
            },
          })
        }
      }

      const controller = new AbortController()
      const options = {
        passive: true,
        signal: controller.signal,
      }
      element.addEventListener(
        'scroll',
        remember,
        options,
      )

      for (const name of [
        'wheel',
        'pointerdown',
        'touchstart',
        'keydown',
      ]) {
        element.addEventListener(
          name,
          stopRestoring,
          options,
        )
      }

      watchContent()
      additions.observe(
        element,
        {
          childList: true,
          subtree: true,
        },
      )
      restore()

      return () => {
        controller.abort()
        stopRestoring()
        view.flush()
      }
    },
    [
      element,
      active,
      view,
    ],
  )

  return {
    ref,
    view,
  }
}
