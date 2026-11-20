import { applyRuntimeStyle } from './runtime-style.ts'
import { FloatingPanel } from './floating-panel.tsx'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export function ContextMenu({
  label,
  at,
  close,
  children,
}: {
  label: string
  at: {
    x: number
    y: number
  }
  close(): void
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(
    () => {
      const element = menu.current

      if (!element) {
        return
      }

      element.showPopover()
      applyRuntimeStyle({
        element,
        values: {
          left: Math.max(
            8,
            Math.min(
              at.x,
              innerWidth - element.offsetWidth - 8,
            ),
          ),
        },
      })
      applyRuntimeStyle({
        element,
        values: {
          top: Math.max(
            8,
            Math.min(
              at.y,
              innerHeight - element.offsetHeight - 8,
            ),
          ),
        },
      })
      element.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    },
    [at],
  )
  useEffect(
    () => {
      const outside = (event: PointerEvent) => {
        if (!menu.current?.contains(event.target as Node)) {
          close()
        }
      }

      document.addEventListener(
        'pointerdown',
        outside,
      )

      return () => document.removeEventListener(
        'pointerdown',
        outside,
      )
    },
    [close],
  )

  return (
    <FloatingPanel
      className="context-menu menu-items z-30 max-h-menu-height max-w-menu-viewport min-w-menu rounded-lg p-1 [&>.button]:flex [&>.button]:min-h-8.5 [&>.button]:w-full [&>.button]:justify-start [&>.button]:rounded-sm [&>.button]:border-0 [&>.button]:px-2.5 [&>.button]:py-1.75 [&>.button]:text-left [&>.button]:text-ui [&>.button]:text-ink [&>.button]:normal-case"
      role="menu"
      aria-label={label}
      ref={menu}
      popover="manual"
      // eslint-disable-next-line pnyx/object-params -- React owns the div event signature.
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation(); close()
        }
      }}
      // eslint-disable-next-line pnyx/object-params -- React owns the div event signature.
      onClick={e => {
        const button = (e.target as Element).closest('button')

        if (button && !button.hasAttribute('data-menu-keep')) {
          close()
        }
      }}
    >{children}
    </FloatingPanel>
  )
}

export const menuPoint = ({
  event,
}: {
  event: {
    clientX?: number
    clientY?: number
    currentTarget: Element
  }
}) => {
  const box = event.currentTarget.getBoundingClientRect()

  return event.clientX ? {
    x: event.clientX,
    y: event.clientY ?? box.bottom,
  } : {
    x: box.left + 12,
    y: box.bottom,
  }
}

export const opensMenu = ({ event }: {
  event: {
    key: string
    shiftKey: boolean
  }
}) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
