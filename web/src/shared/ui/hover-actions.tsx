import { applyRuntimeStyle } from './runtime-style.ts'
import { useId, useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode, type RefObject } from 'react'
import { frame, cancelFrame } from 'motion/react'
import { HOVER_CLAIM } from './tooltip.tsx'

// The attribute that marks a card's button opening its actions on touch screens.
export const ACTIONS_TRIGGER = 'data-actions-trigger'
const VIEWPORT_GAP = 8
const CARD_INSET = 10

export function HoverActions({
  anchor,
  children,
}: {
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const prepared = useRef(false)
  const opening = useRef<(() => void) | null>(null)
  const [
    mounted,
    setMounted,
  ] = useState(false)
  const position = useCallback(
    () => {
      const card = anchor.current, element = panel.current

      if (!card || !element?.matches(':popover-open')) {
        return
      }

      const rect = card.getBoundingClientRect()
      const left = Math.max(
        VIEWPORT_GAP,
        Math.min(
          rect.right - element.offsetWidth - CARD_INSET,
          innerWidth - element.offsetWidth - VIEWPORT_GAP,
        ),
      )
      const top = Math.max(
        VIEWPORT_GAP,
        Math.min(
          rect.top - element.offsetHeight / 2,
          innerHeight - element.offsetHeight - VIEWPORT_GAP,
        ),
      )
      applyRuntimeStyle({
        element,
        values: {
          left,
          top,
        },
      })
    },
    [anchor],
  )

  useLayoutEffect(
    () => {
      prepared.current = mounted
      const show = opening.current
      opening.current = null
      show?.()
    },
    [mounted],
  )

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
        opening.current = null

        if (!element.isConnected) {
          return
        }

        hiding = true
        element.hidePopover()
        queueMicrotask(() => {
          hiding = false
        })
      }

      const reveal = () => {
        document.dispatchEvent(new CustomEvent(
          HOVER_CLAIM,
          {
            detail: {
              id,
              anchor: card,
            },
          },
        ))

        const open = () => {
          if (card.isConnected && element.isConnected) {
            element.showPopover()
            position()
          }
        }

        if (!prepared.current) {
          opening.current = open
          setMounted(true)
        } else {
          open()
        }
      }

      const show = (event: Event) => {
        // A tap is not a hover: touch screens open the actions from the card's own button instead.
        const touched = event instanceof PointerEvent && event.pointerType === 'touch'
        const focusedByPointer = event.type === 'focusin' && !keyboardFocus()
        const onTooltip = event.target instanceof Element && !!event.target.closest('.tooltip-anchor')

        if (touched || hiding || card.closest('[data-dragging]') || focusedByPointer || onTooltip) {
          return
        }

        reveal()
      }

      const leave = (event: PointerEvent) => {
        const lifted = event.pointerType === 'touch'

        if (lifted || (event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) {
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

      const toggle = (event: MouseEvent) => {
        if (!(event.target instanceof Element) || !event.target.closest(`[${ACTIONS_TRIGGER}]`)) {
          return
        }

        if (element.matches(':popover-open')) {
          hide()
        } else {
          reveal()
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
        'click',
        toggle,
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

      const track = () => {
        if (element.matches(':popover-open')) {
          frame.postRender(
            position,
            true,
          )
        } else {
          cancelFrame(position)
        }
      }

      element.addEventListener(
        'toggle',
        track,
      )
      const observer = new ResizeObserver(position)
      observer.observe(card)

      return () => {
        observer.disconnect()
        cancelFrame(position)
        element.removeEventListener(
          'toggle',
          track,
        )
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
          'click',
          toggle,
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
      position,
    ],
  )

  return (
    <div
      ref={panel}
      popover="manual"
      className="card-menu pointer-events-none fixed inset-auto m-0 hidden w-max max-w-menu-viewport items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 opacity-0 shadow-actions transition-opacity duration-fast open:pointer-events-auto open:flex open:opacity-100 motion-reduce:transition-none starting:open:opacity-0 [&_.tooltip-anchor]:inline-flex"
    >{mounted && children}
    </div>
  )
}
