import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const CLAIM = 'pnyx-tooltip'
export const LINK_TOOLTIP_DELAY = 1500
const GAP = 8

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
  const [
    visible,
    setVisible,
  ] = useState(false)

  const hide = () => {
    clearTimeout(timer.current)
    setVisible(false)
  }

  const show = () => {
    document.dispatchEvent(new CustomEvent(
      CLAIM,
      { detail: id },
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
        if (event instanceof CustomEvent && event.detail !== id) {
          hide()
        }
      }

      document.addEventListener(
        CLAIM,
        claimed,
      )
      document.addEventListener(
        'scroll',
        hide,
        true,
      )
      window.addEventListener(
        'resize',
        hide,
      )

      return () => {
        clearTimeout(timer.current)
        document.removeEventListener(
          CLAIM,
          claimed,
        )
        document.removeEventListener(
          'scroll',
          hide,
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
      element.style.top = `${Math.max(
        GAP,
        rect.top - element.offsetHeight - GAP,
      )}px`
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
      onPointerLeave={hide}
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
        >{content}
        </span>
      )}
    </span>
  )
}
