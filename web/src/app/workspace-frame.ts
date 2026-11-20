import { useLayoutEffect, useRef } from 'react'
import { animate } from 'motion/react'
import { useMotionDuration, MOTION_EASING } from '#web-shared/motion.ts'
import { WORKSPACE_SIZING } from '#web-shared/card-sizing.ts'
import { useWorkspaceViewport } from './workspace-viewport.tsx'

export function useWorkspaceFrame({
  element,
  collapsed,
  loaded,
}: {
  element: HTMLElement | null
  collapsed: boolean
  loaded: boolean
}) {
  const viewport = useWorkspaceViewport()
  const duration = useMotionDuration()
  const previous = useRef({
    collapsed,
    loaded,
  })
  const frameWidth = collapsed ? WORKSPACE_SIZING.foldedHydra : 'auto'
  const frameMargin = viewport.width <= WORKSPACE_SIZING.phone
    ? WORKSPACE_SIZING.phoneFrameMargin : WORKSPACE_SIZING.frameMargin
  const minimum = collapsed ? WORKSPACE_SIZING.foldedHydra : viewport.width - frameMargin
  useLayoutEffect(
    () => {
      if (!element) {
        return
      }

      const folding = previous.current.loaded && previous.current.collapsed !== collapsed
      previous.current = {
        collapsed,
        loaded,
      }
      const sizing = animate(
        element,
        {
          width: frameWidth,
          minWidth: minimum,
        },
        {
          duration: folding ? duration / 1000 : 0,
          ease: MOTION_EASING,
        },
      )

      return () => sizing.stop()
    },
    [
      element,
      collapsed,
      loaded,
      frameWidth,
      minimum,
      duration,
    ],
  )

  return {
    minimum,
    duration,
  }
}
