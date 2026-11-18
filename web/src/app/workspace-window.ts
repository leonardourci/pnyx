import { useLayoutEffect, useState } from 'react'
import { useWorkspaceViewport } from './workspace-viewport.tsx'

export function useWorkspaceWindow({
  element,
  hydra,
  width,
  collapsed,
}: {
  element: HTMLElement | null
  hydra: string
  width: number
  collapsed: boolean
}) {
  const viewport = useWorkspaceViewport()
  const [
    visible,
    setVisible,
  ] = useState(false)
  const mounted = visible || viewport.hydras.has(hydra)
  useLayoutEffect(
    () => {
      if (!element) {
        return
      }

      const observer = new IntersectionObserver(
        // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
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
    width: collapsed || mounted ? undefined : width,
  }
}
