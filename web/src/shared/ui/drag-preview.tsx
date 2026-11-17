import { useLayoutEffect, useRef } from 'react'

export function dragSnapshot({ element }: { element: HTMLElement }) {
  const snapshot = element.cloneNode(true) as HTMLElement

  for (const node of [
    snapshot,
    ...snapshot.querySelectorAll<HTMLElement>('*'),
  ]) {
    node.removeAttribute('id')
    node.removeAttribute('data-sort-key')
    node.removeAttribute('aria-controls')
    node.removeAttribute('aria-labelledby')
    node.removeAttribute('aria-describedby')
  }

  snapshot.style.margin = '0'
  snapshot.style.width = '100%'
  snapshot.style.height = '100%'
  snapshot.style.transform = 'none'
  snapshot.style.position = 'relative'
  snapshot.inert = true

  return snapshot
}

export function DragPreview({ snapshot }: { snapshot: HTMLElement }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(
    () => {
      root.current?.replaceChildren(snapshot)

      return () => snapshot.remove()
    },
    [snapshot],
  )

  return <div ref={root} className="h-full w-full" aria-hidden="true" />
}
