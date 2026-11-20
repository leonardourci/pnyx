import { useLayoutEffect, useRef, useState } from 'react'
import { animate } from 'motion/react'
import { useMotionDuration, MOTION_EASING } from '#web-shared/motion.ts'
import { WORKSPACE_SIZING } from '#web-shared/card-sizing.ts'
import { useWorkspaceViewport } from './workspace-viewport.tsx'

export function useWorkspaceWindow({
  element,
  hydra,
  width,
  collapsed,
  loaded,
}: {
  element: HTMLElement | null
  hydra: string
  width: number
  collapsed: boolean
  loaded: boolean
}) {
  const viewport = useWorkspaceViewport()
  const [
    visible,
    setVisible,
  ] = useState(false)
  const mounted = visible || viewport.hydras.has(hydra)
  const duration = useMotionDuration()
  const previous = useRef({
    collapsed,
    loaded,
  })
  const placeholderWidth = collapsed || mounted ? undefined : width
  const frameWidth = collapsed ? WORKSPACE_SIZING.foldedHydra : placeholderWidth ?? 'auto'
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
  useLayoutEffect(
    () => {
      if (!element) {
        return
      }

      const observer = new IntersectionObserver(

        entries => {
          setVisible(entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0
            && entry.intersectionRect.height > 0))
        },
        {
          root: viewport.axis.current,
          // Crossing from an edge-only intersection into view must emit another entry.
          threshold: Number.EPSILON,
        },
      )
      observer.observe(element)

      return () => observer.disconnect()
    },
    [
      element,
      viewport.axis,
    ],
  )

  return {
    mounted,
    minimum,
    duration,
    width: placeholderWidth,
  }
}
