import { useId, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { HOVER_CLAIM } from './tooltip.tsx'

export const CARD_LAYOUT_COMPLETE = 'pnyx-card-layout-complete'

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

      const nativeAnchor = CSS.supports(
        'position-anchor',
        '--pnyx-hover',
      )
        && CSS.supports(
          'left',
          'anchor(right)',
        )
      const previousAnchor = card.style.anchorName

      if (nativeAnchor) {
        const name = `--pnyx-hover-${CSS.escape(id)}`
        card.style.anchorName = name
        element.style.positionAnchor = name
      }

      const position = () => {
        if (nativeAnchor) {
          element.style.setProperty(
            '--hover-width',
            `${element.offsetWidth}px`,
          )
          element.style.setProperty(
            '--hover-height',
            `${element.offsetHeight}px`,
          )

          return
        }

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
        if (hiding || card.closest('[data-dragging]') || (event.type === 'focusin' && !keyboardFocus())) {
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

      if (!nativeAnchor) {
        document.addEventListener(
          'scroll',
          position,
          true,
        )
        window.addEventListener(
          'resize',
          position,
        )
        card.addEventListener(
          CARD_LAYOUT_COMPLETE,
          position,
        )
      }

      const observer = new ResizeObserver(position)
      observer.observe(nativeAnchor ? element : card)

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

        if (nativeAnchor) {
          card.style.anchorName = previousAnchor
        } else {
          document.removeEventListener(
            'scroll',
            position,
            true,
          )
          window.removeEventListener(
            'resize',
            position,
          )
          card.removeEventListener(
            CARD_LAYOUT_COMPLETE,
            position,
          )
        }
      }
    },
    [
      anchor,
      id,
    ],
  )

  return <div ref={panel} popover="manual" className="card-menu fixed inset-auto [left:clamp(calc(var(--spacing)*2),calc(anchor(right)-var(--hover-width)-var(--spacing)*2.5),calc(100vw-var(--hover-width)-var(--spacing)*2))] [top:max(calc(var(--spacing)*2),calc(anchor(top)-var(--hover-height)/2))] m-0 hidden w-max max-w-[calc(100vw-1rem)] items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-actions opacity-0 pointer-events-none transition-opacity duration-110 transition-discrete open:flex open:opacity-100 open:pointer-events-auto starting:open:opacity-0 motion-reduce:transition-none [&_.tooltip-anchor]:inline-flex [&_.button]:rounded-full [&_.button]:px-1.5 [&_.button]:py-0.5 [&_.button]:text-meta [&>.tooltip-anchor>.button]:p-1.25 [&>.tooltip-anchor>.button]:min-w-6.5 [&>.tooltip-anchor>.button]:min-h-6.5">{children}</div>
}
