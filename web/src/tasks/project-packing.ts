import { useLayoutEffect, useRef, type RefObject } from 'react'
import { CARD_GAP } from './project-layout.ts'

const FLOW_DURATION_MS = 200
const FLOW_EASING = 'cubic-bezier(.22,1,.36,1)'
interface Space {
  left: number
  top: number
  right: number
  bottom: number
}

function overlaps({
  a,
  b,
}: {
  a: Space
  b: Space
}) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function remainingSpace({
  spaces,
  used,
}: {
  spaces: Space[]
  used: Space
}) {
  const next: Space[] = []

  for (const space of spaces) {
    if (!overlaps({
      a: space,
      b: used,
    })) {
      next.push(space)
      continue
    }

    if (used.left > space.left) {
      next.push({
        ...space,
        right: used.left,
      })
    }

    if (used.right < space.right) {
      next.push({
        ...space,
        left: used.right,
      })
    }

    if (used.top > space.top) {
      next.push({
        ...space,
        bottom: used.top,
      })
    }

    if (used.bottom < space.bottom) {
      next.push({
        ...space,
        top: used.bottom,
      })
    }
  }

  return next.filter((
    space,
    index,
  ) => !next.some((
    other,
    otherIndex,
  ) =>
    index !== otherIndex && other.left <= space.left && other.right >= space.right
    && other.top <= space.top && other.bottom >= space.bottom
    && (otherIndex < index || other.left < space.left || other.right > space.right
      || other.top < space.top || other.bottom > space.bottom)))
}

export function useProjectPacking({ root }: { root: RefObject<HTMLElement | null> }) {
  const positions = useRef(new Map<HTMLElement, {
    left: number
    top: number
  }>())
  const animations = useRef(new Map<HTMLElement, Animation>())
  const measured = useRef<{
    width: number
    cards: {
      card: HTMLElement
      width: number
      height: number
    }[]
  } | null>(null)

  useLayoutEffect(() => {
    const grid = root.current

    if (!grid) {
      return
    }

    const pack = () => {
      if (!grid.clientWidth) {
        return
      }

      const cards = [...grid.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      )
      const sizes = cards.map(card => ({
        card,
        width: card.offsetWidth,
        height: card.offsetHeight,
      }))
      const previousLayout = measured.current
      const unchanged = previousLayout?.width === grid.clientWidth
        && previousLayout.cards.length === sizes.length
        && sizes.every((
          item,
          index,
        ) => {
          const before = previousLayout.cards[index]!

          return before.card === item.card && before.width === item.width
            && before.height === item.height
        })

      if (unchanged) {
        return
      }

      measured.current = {
        width: grid.clientWidth,
        cards: sizes,
      }
      let spaces: Space[] = [
        {
          left: 0,
          top: 0,
          right: grid.clientWidth,
          bottom: Infinity,
        },
      ]
      let bottom = 0
      const next = new Map<HTMLElement, {
        left: number
        top: number
      }>()
      const dragging = !!grid.closest('[data-dragging]')
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

      for (const item of sizes) {
        const { card } = item
        const width = Math.min(
          item.width + CARD_GAP,
          grid.clientWidth,
        )
        const height = item.height + CARD_GAP
        const space = spaces.filter(space => space.right - space.left >= width
          && space.bottom - space.top >= height)
          .sort((
            a,
            b,
          ) => a.top - b.top || a.left - b.left)[0]

        if (!space) {
          throw new Error('No space available for a project card')
        }

        const position = {
          left: space.left,
          top: space.top,
        }
        const used = {
          ...position,
          right: position.left + width,
          bottom: position.top + height,
        }
        spaces = remainingSpace({
          spaces,
          used,
        })
        bottom = Math.max(
          bottom,
          used.bottom - CARD_GAP,
        )
        card.style.left = `${position.left}px`
        card.style.top = `${position.top}px`
        next.set(
          card,
          position,
        )
        const before = positions.current.get(card)
        const previous = animations.current.get(card)

        if (!before || dragging || reduced) {
          previous?.cancel()
          continue
        }

        let dx = before.left - position.left, dy = before.top - position.top

        if (Math.abs(dx) + Math.abs(dy) <= 1) {
          continue
        }

        if (previous?.playState === 'running') {
          const transform = new DOMMatrixReadOnly(getComputedStyle(card).transform)
          dx += transform.m41
          dy += transform.m42
        }

        previous?.cancel()
        const animation = card.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'none' },
          ],
          {
            duration: FLOW_DURATION_MS,
            easing: FLOW_EASING,
          },
        )
        animations.current.set(
          card,
          animation,
        )

        animation.onfinish = () => {
          if (animations.current.get(card) === animation) {
            animations.current.delete(card)
          }
        }
      }

      for (const [
        card,
        animation,
      ] of animations.current) {
        if (!next.has(card)) {
          animation.cancel()
          animations.current.delete(card)
        }
      }

      grid.style.height = `${bottom}px`
      positions.current = next
    }

    pack()
    const observer = new ResizeObserver(pack)
    observer.observe(grid)

    for (const card of grid.children) {
      observer.observe(card)
    }

    return () => observer.disconnect()
  })

  useLayoutEffect(
    () => () => animations.current.forEach(animation => animation.cancel()),
    [],
  )
}
