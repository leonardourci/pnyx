import { Icon } from './icon.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './controls.tsx'

export function Menu({
  label,
  trigger: triggerContent,
  children,
}: {
  label: string
  trigger?: ReactNode
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
      className="menu"
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
      >{triggerContent ?? <Icon name="more" />}
      </Button>
      {open && (
        <div
          className="menu-items"
          ref={menu}
          popover="manual"
          onClick={e => {
            const button = (e.target as Element).closest('button')

            if (button && !button.hasAttribute('data-menu-keep')) {
              setOpen(false)
            }
          }}
        >{children}
        </div>
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

  return asking && refusal ? <p className="delete-refused" role="status">{refusal}</p> : asking ? (
    <div className="delete-confirm" aria-label={`Confirm ${label}`}>
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
    </div>
  ) : <Button data-menu-keep disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>
}
