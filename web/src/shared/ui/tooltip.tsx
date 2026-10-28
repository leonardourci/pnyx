import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export const HOVER_CLAIM = 'pnyx-tooltip'
export const LINK_TOOLTIP_DELAY = 1500
const GAP = 8
const CLOSE_DELAY_MS = 180

export function TooltipPanel({ children }: { children: ReactNode }) {
  return <span className="tooltip-panel">{children}</span>
}

export function TooltipSection({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={`tooltip-section ${className}`}>{children}</span>
}

export function Tooltip({
  content,
  delay = 0,
  children,
}: {
  content: ReactNode
  delay?: number
  children: ReactNode
}) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [
    visible,
    setVisible,
  ] = useState(false)

  const hide = () => {
    clearTimeout(timer.current)
    clearTimeout(closeTimer.current)
    setVisible(false)
  }

  const leave = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(
      hide,
      CLOSE_DELAY_MS,
    )
  }

  const hideOnScroll = (event: Event) => {
    if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) {
      hide()
    }
  }

  const show = () => {
    clearTimeout(closeTimer.current)
    document.dispatchEvent(new CustomEvent(
      HOVER_CLAIM,
      {
        detail: {
          id,
          anchor: anchor.current,
        },
      },
    ))
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => setVisible(true),
      delay,
    )
  }

  useEffect(
    () => {
      const claimed = (event: Event) => {
        if (event instanceof CustomEvent && event.detail.id !== id) {
          hide()
        }
      }

      document.addEventListener(
        HOVER_CLAIM,
        claimed,
      )
      document.addEventListener(
        'scroll',
        hideOnScroll,
        true,
      )
      window.addEventListener(
        'resize',
        hide,
      )

      return () => {
        clearTimeout(timer.current)
        clearTimeout(closeTimer.current)
        document.removeEventListener(
          HOVER_CLAIM,
          claimed,
        )
        document.removeEventListener(
          'scroll',
          hideOnScroll,
          true,
        )
        window.removeEventListener(
          'resize',
          hide,
        )
      }
    },
    [id],
  )

  useLayoutEffect(
    () => {
      const element = panel.current
      const rect = anchor.current?.getBoundingClientRect()

      if (!visible || !element || !rect) {
        return
      }

      element.showPopover()
      element.style.left = `${Math.max(
        GAP,
        Math.min(
          rect.left + rect.width / 2 - element.offsetWidth / 2,
          innerWidth - element.offsetWidth - GAP,
        ),
      )}px`
      const aboveSpace = Math.max(
        0,
        rect.top - GAP * 2,
      )
      const belowSpace = Math.max(
        0,
        innerHeight - rect.bottom - GAP * 2,
      )
      const fitsAbove = element.offsetHeight <= aboveSpace
      const fitsBelow = element.offsetHeight <= belowSpace
      const above = fitsAbove || (!fitsBelow && aboveSpace >= belowSpace)
      const available = above ? aboveSpace : belowSpace
      element.style.maxHeight = `${available}px`
      element.style.top = `${above ? rect.top - element.offsetHeight - GAP : rect.bottom + GAP}px`
      const focused = document.activeElement

      if (!(focused instanceof HTMLElement) || !anchor.current?.contains(focused)) {
        return
      }

      const description = focused.getAttribute('aria-describedby')
      focused.setAttribute(
        'aria-describedby',
        [
          description,
          id,
        ].filter(Boolean).join(' '),
      )

      return () => {
        if (description) {
          focused.setAttribute(
            'aria-describedby',
            description,
          )
        } else {
          focused.removeAttribute('aria-describedby')
        }
      }
    },
    [
      visible,
      id,
    ],
  )

  return (
    <span
      ref={anchor}
      className="tooltip-anchor"
      data-tooltip-active={visible || undefined}
      aria-describedby={visible ? id : undefined}
      onPointerEnter={show}
      onPointerLeave={leave}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          hide()
        }
      }}
    >
      {children}
      {visible && (
        <span
          ref={panel}
          id={id}
          role="tooltip"
          popover="manual"
          className="tooltip"
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={leave}
        >{content}
        </span>
      )}
    </span>
  )
}
