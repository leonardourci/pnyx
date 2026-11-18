import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export const HOVER_CLAIM = 'pnyx-tooltip'
export const LINK_TOOLTIP_DELAY = 1500
const GAP = 8
const CLOSE_DELAY_MS = 180

export function TooltipPanel({ children }: { children: ReactNode }) {
  return <span className="tooltip-panel flex flex-col gap-2.5 min-w-60 py-1 px-0.5 has-[>.shared-usage]:p-0 has-[>.shared-usage]:gap-0 [&_.usage-session-details]:pt-0 [&_.usage-session-details]:px-3.25 [&_.usage-session-details]:pb-3.25">{children}</span>
}

export function TooltipSection({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={`tooltip-section flex flex-col [:where(&)]:gap-1 ${className}`}>{children}</span>
}

export function Tooltip({
  content,
  anchorClassName = '',
  delay = 0,
  children,
  interactive = false,
  label,
  disabled = false,
}: {
  content: ReactNode
  anchorClassName?: string
  delay?: number
  children: ReactNode
  interactive?: boolean
  label?: string
  disabled?: boolean
}) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const dismissal = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [
    requested,
    setVisible,
  ] = useState(false)
  const visible = requested && !disabled

  const hide = () => {
    clearTimeout(timer.current)
    clearTimeout(closeTimer.current)
    dismissal.current?.abort()
    dismissal.current = null
    setVisible(false)
  }

  // Disabling drops a tooltip already showing or waiting on its delay, so it needs a new hover or focus to return.
  useEffect(
    () => {
      if (disabled) {
        hide()
      }
    },
    [disabled],
  )

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
    if (disabled || anchor.current?.closest('[data-dragging]')) {
      return
    }

    if (!dismissal.current) {
      const controller = new AbortController()
      dismissal.current = controller

      const claimed = (event: Event) => {
        if (event instanceof CustomEvent && event.detail.id !== id) {
          hide()
        }
      }

      document.addEventListener(
        HOVER_CLAIM,
        claimed,
        { signal: controller.signal },
      )
      document.addEventListener(
        'scroll',
        hideOnScroll,
        {
          capture: true,
          signal: controller.signal,
        },
      )
      window.addEventListener(
        'resize',
        hide,
        { signal: controller.signal },
      )
    }

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
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(closeTimer.current)
      dismissal.current?.abort()
    },
    [],
  )

  useLayoutEffect(
    () => {
      const element = panel.current

      if (!visible || !element) {
        return
      }

      const rect = anchor.current?.getBoundingClientRect()

      if (!rect) {
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
      className={`tooltip-anchor [:where(&)]:inline-flex min-w-0 max-w-full ${anchorClassName}`}
      data-tooltip-active={visible || undefined}
      aria-describedby={visible ? id : undefined}
      onPointerEnter={show}
      onPointerLeave={leave}
      onFocus={show}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          hide()
        }
      }}
      onPointerDown={event => {
        if (event.target instanceof Node && panel.current?.contains(event.target)) {
          return
        }

        hide()
      }}
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
          role={interactive ? 'dialog' : 'tooltip'}
          aria-label={label}
          popover="manual"
          className="tooltip has-[.shared-usage]:w-84 has-[.shared-usage]:max-w-usage-tooltip has-[.shared-usage]:p-0 fixed inset-auto m-0 max-w-floating-panel py-1.25 px-2 border-0 rounded-md bg-ink text-surface text-meta leading-question wrap-anywhere overflow-y-auto overscroll-contain pointer-events-auto opacity-100 starting:opacity-0 transition-opacity duration-base ease-ui motion-reduce:transition-none [:where(&)_:is(strong,span)]:block [&_mark]:px-px [&_mark]:py-0 [&_mark]:rounded-xs [&_mark]:bg-gold/45 [&_mark]:text-inherit"
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={leave}
        >{content}
        </span>
      )}
    </span>
  )
}
