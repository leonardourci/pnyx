import { useId, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { HOVER_CLAIM } from './tooltip.tsx'

export function HoverActions({
  anchor,
  children,
}: {
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(
    () => {
      const card = anchor.current
      const element = panel.current

      if (!card || !element) {
        return
      }

      let hiding = false

      const keyboardFocus = () => {
        const focused = document.activeElement

        return focused instanceof HTMLElement && focused.matches(':focus-visible')
          && (element.contains(focused) || (card.contains(focused) && focused.matches('.card-open')))
      }

      const hovered = () => card.matches(':hover') || element.matches(':hover')

      const hide = () => {
        if (!element.isConnected) {
          return
        }

        hiding = true
        element.hidePopover()
        queueMicrotask(() => {
          hiding = false
        })
      }

      const position = () => {
        const rect = card.getBoundingClientRect()
        element.style.left = `${Math.max(
          8,
          Math.min(
            rect.right - element.offsetWidth - 10,
            innerWidth - element.offsetWidth - 8,
          ),
        )}px`
        element.style.top = `${Math.max(
          8,
          rect.top - element.offsetHeight / 2,
        )}px`
      }

      const show = (event: Event) => {
        if (hiding || (event.type === 'focusin' && !keyboardFocus())) {
          return
        }

        if (event.target instanceof Element && event.target.closest('.tooltip-anchor')) {
          return
        }

        document.dispatchEvent(new CustomEvent(
          HOVER_CLAIM,
          {
            detail: {
              id,
              anchor: card,
            },
          },
        ))
        element.showPopover()
        position()
      }

      const leave = (event: PointerEvent) => {
        if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) {
          return
        }

        if (!keyboardFocus()) {
          hide()
        }
      }

      const blur = (event: FocusEvent) => {
        const next = event.relatedTarget

        if (next instanceof HTMLElement && (element.contains(next)
          || (card.contains(next) && next.matches('.card-open')))) {
          return
        }

        if (!hovered()) {
          hide()
        }
      }

      const claimed = (event: Event) => {
        if (event instanceof CustomEvent && event.detail.id !== id
          && !element.contains(event.detail.anchor)) {
          hide()
        }
      }

      card.addEventListener(
        'pointerover',
        show,
      )
      card.addEventListener(
        'pointerleave',
        leave,
      )
      element.addEventListener(
        'pointerleave',
        leave,
      )
      card.addEventListener(
        'focusin',
        show,
      )
      card.addEventListener(
        'focusout',
        blur,
      )
      document.addEventListener(
        HOVER_CLAIM,
        claimed,
      )
      document.addEventListener(
        'scroll',
        position,
        true,
      )
      window.addEventListener(
        'resize',
        position,
      )
      const observer = new ResizeObserver(position)
      observer.observe(card)

      return () => {
        observer.disconnect()
        card.removeEventListener(
          'pointerover',
          show,
        )
        card.removeEventListener(
          'pointerleave',
          leave,
        )
        element.removeEventListener(
          'pointerleave',
          leave,
        )
        card.removeEventListener(
          'focusin',
          show,
        )
        card.removeEventListener(
          'focusout',
          blur,
        )
        document.removeEventListener(
          HOVER_CLAIM,
          claimed,
        )
        document.removeEventListener(
          'scroll',
          position,
          true,
        )
        window.removeEventListener(
          'resize',
          position,
        )
      }
    },
    [
      anchor,
      id,
    ],
  )

  return <div ref={panel} popover="manual" className="card-menu">{children}</div>
}
