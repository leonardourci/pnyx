import { useId, useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode, type RefObject } from 'react'
import { useAnimationFrame, frame, cancelFrame } from 'motion/react'
import { HOVER_CLAIM } from './tooltip.tsx'

const VIEWPORT_GAP = 8
const CARD_INSET = 10

function TrackActions({ position }: { position(): void }) {
  useAnimationFrame(() => frame.postRender(position))
  useEffect(
    () => () => cancelFrame(position),
    [position],
  )

  return null
}

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
  const [
    visible,
    setVisible,
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
      element.style.left = `${left}px`
      element.style.top = `${top}px`
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
      position,
    ],
  )

  return (
    <div
      ref={panel}
      popover="manual"
      onToggle={() => setVisible(panel.current?.matches(':popover-open') ?? false)}
      className="card-menu fixed inset-auto m-0 hidden w-max max-w-[calc(100vw-1rem)] items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-actions opacity-0 pointer-events-none transition-opacity duration-fast open:flex open:opacity-100 open:pointer-events-auto starting:open:opacity-0 motion-reduce:transition-none [&_.tooltip-anchor]:inline-flex"
    >{visible && <TrackActions position={position} />}{mounted && children}
    </div>
  )
}
