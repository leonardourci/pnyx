import { FloatingPanel } from './floating-panel.tsx'
import { Icon } from './icon.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Button } from './controls.tsx'

function MenuSurface({
  variant = 'menu',
  className = '',
  ...props
}: ComponentProps<'div'> & { variant?: 'menu' | 'confirm' }) {
  const layout = variant === 'confirm'
    ? 'delete-confirm flex'
    : 'menu-items z-30 min-w-menu max-w-menu-viewport max-h-menu-height p-1 rounded-lg'

  const Surface = variant === 'confirm' ? 'div' : FloatingPanel

  return <Surface {...props} className={`${layout} [&>.button]:flex [&>.button]:w-full [&>.button]:min-h-8.5 [&>.button]:px-2.5 [&>.button]:py-1.75 [&>.button]:text-ui [&>.button]:justify-start [&>.button]:text-left [&>.button]:border-0 [&>.button]:rounded-sm [&>.button]:text-ink [&>.button]:normal-case ${className}`} />
}

export function Menu({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const [
    open,
    setOpen,
  ] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(
    () => {
      const element = menu.current

      if (!open || !element) {
        return
      }

      element.showPopover()

      const position = () => {
        const anchor = trigger.current?.getBoundingClientRect()

        if (anchor) {
          element.style.left = `${Math.max(
            8,
            Math.min(
              anchor.right - element.offsetWidth,
              innerWidth - element.offsetWidth - 8,
            ),
          )}px`
          element.style.top = `${Math.max(
            8,
            Math.min(
              anchor.bottom + 5,
              innerHeight - element.offsetHeight - 8,
            ),
          )}px`
        }
      }

      position()
      const observer = new ResizeObserver(position)
      observer.observe(element)
      window.addEventListener(
        'resize',
        position,
      )
      document.addEventListener(
        'scroll',
        position,
        true,
      )

      return () => {
        observer.disconnect()
        window.removeEventListener(
          'resize',
          position,
        )
        document.removeEventListener(
          'scroll',
          position,
          true,
        )
      }
    },
    [open],
  )
  useEffect(
    () => {
      if (!open) {
        return
      }

      const outside = (event: PointerEvent) => {
        if (!root.current?.contains(event.target as Node)) {
          setOpen(false)
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
    [open],
  )

  return (
    <div
      className="menu relative"
      ref={root}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation(); setOpen(false); trigger.current?.focus()
        }
      }}
    >
      <Button
        ref={trigger}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      ><Icon name="more" />
      </Button>
      {open && (
        <MenuSurface
          ref={menu}
          popover="manual"
          // eslint-disable-next-line pnyx/object-params -- React owns the div event signature.
          onClick={e => {
            const button = (e.target as Element).closest('button')

            if (button && !button.hasAttribute('data-menu-keep')) {
              setOpen(false)
            }
          }}
        >{children}
        </MenuSurface>
      )}
    </div>
  )
}

export function DeleteItem({
  label,
  disabled,
  refusal,
  confirm,
}: {
  label: string
  disabled?: boolean
  refusal?: string
  confirm(): Promise<unknown>
}) {
  const [
      asking,
      setAsking,
    ] = useState(false), [
      busy,
      setBusy,
    ] = useState(false)

  return asking && refusal ? <p className="delete-refused m-0 px-2.5 py-1.75 max-w-65 text-ui text-muted" role="status">{refusal}</p> : asking ? (
    <MenuSurface variant="confirm" aria-label={`Confirm ${label}`}>
      <Button
        data-menu-keep
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void confirm().then(() => setAsking(false))
            .finally(() => setBusy(false))
        }}
      >Yes
      </Button>
      <Button data-menu-keep disabled={busy} onClick={() => setAsking(false)}>No</Button>
    </MenuSurface>
  ) : <Button data-menu-keep disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>
}

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
      element.style.left = `${Math.max(
        8,
        Math.min(
          at.x,
          innerWidth - element.offsetWidth - 8,
        ),
      )}px`
      element.style.top = `${Math.max(
        8,
        Math.min(
          at.y,
          innerHeight - element.offsetHeight - 8,
        ),
      )}px`
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
    <MenuSurface
      className="context-menu"
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
    </MenuSurface>
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
