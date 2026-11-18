import { useLayoutEffect, useState } from 'react'
import { useWorkspaceViewport } from './workspace-viewport.tsx'

export function useWorkspaceWindow({
  element,
  hydra,
  active,
  width,
  collapsed,
}: {
  element: HTMLElement | null
  hydra: string
  active: boolean
  width: number
  collapsed: boolean
}) {
  const viewport = useWorkspaceViewport()
  const [
    visible,
    setVisible,
  ] = useState(active)
  const mounted = visible || viewport.hydras.has(hydra)
  useLayoutEffect(
    () => {
      if (!element) {
        return
      }

      const observer = new IntersectionObserver(
        // eslint-disable-next-line pnyx/object-params -- The library owns this callback signature.
        entries => {
          setVisible(entries.some(entry => entry.isIntersecting))
        },
        { root: viewport.axis.current },
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
