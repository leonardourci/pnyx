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

      const hide = () => element.hidePopover()

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

      const leave = () => {
        if (!card.contains(document.activeElement) && !element.querySelector('[aria-expanded=true]')) {
          hide()
        }
      }

      const blur = (event: FocusEvent) => {
        if (!card.contains(event.relatedTarget as Node) && !card.matches(':hover')) {
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
