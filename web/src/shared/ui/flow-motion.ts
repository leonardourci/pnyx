import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const FLOW_DURATION_MS = 180

export function useFlowMotion({ root }: { root: RefObject<HTMLElement | null> }) {
  const positions = useRef(new Map<Element, {
    left: number
    top: number
  }>())
  const animations = useRef(new Map<HTMLElement, Animation>())
  useEffect(
    () => () => animations.current.forEach(animation => animation.cancel()),
    [],
  )
  useLayoutEffect(() => {
    const element = root.current

    if (!element) {
      return
    }

    const animate = () => {
      const dragging = element.closest('[data-dragging]')
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      const next = new Map<Element, {
        left: number
        top: number
      }>()

      for (const child of element.children) {
        if (!(child instanceof HTMLElement)) {
          continue
        }

        const position = {
          left: child.offsetLeft,
          top: child.offsetTop,
        }
        const before = positions.current.get(child)
        next.set(
          child,
          position,
        )

        if (!before || dragging || reduced) {
          continue
        }

        let dx = before.left - position.left, dy = before.top - position.top

        if (Math.abs(dx) + Math.abs(dy) <= 1) {
          continue
        }

        const previous = animations.current.get(child)

        if (previous?.playState === 'running') {
          const transform = new DOMMatrixReadOnly(getComputedStyle(child).transform)
          dx += transform.m41; dy += transform.m42
        }

        previous?.cancel()
        const animation = child.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'none' },
          ],
          {
            duration: FLOW_DURATION_MS,
            easing: 'cubic-bezier(.2,.8,.2,1)',
          },
        )
        animations.current.set(
          child,
          animation,
        )

        animation.onfinish = () => {
          if (animations.current.get(child) === animation) {
            animations.current.delete(child)
          }
        }
      }

      for (const [
        child,
        animation,
      ] of animations.current) {
        if (!next.has(child)) {
          animation.cancel(); animations.current.delete(child)
        }
      }

      positions.current = next
    }

    animate()
    const observer = new ResizeObserver(animate)
    observer.observe(element)

    for (const child of element.children) {
      observer.observe(child)
    }

    return () => observer.disconnect()
  })
}
