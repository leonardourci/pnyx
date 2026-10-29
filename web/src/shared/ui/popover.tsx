import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from './controls.tsx'

export function Popover({
  label,
  trigger,
  children,
  className = '',
  triggerRef,
  below = false,
}: {
  label: string
  trigger: ReactNode
  children({ close }: { close(): void }): ReactNode
  className?: string
  triggerRef?: RefObject<HTMLButtonElement | null>
  // Opens under the trigger, for a trigger near the top of the page.
  below?: boolean
}) {
  const [
    open,
    setOpen,
  ] = useState(false)
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  const close = () => {
    setOpen(false); button.current?.focus()
  }

  useLayoutEffect(
    () => {
      const element = panel.current

      if (!open || !element) {
        return
      }

      element.showPopover()

      const position = () => {
        const anchor = button.current?.getBoundingClientRect()

        if (anchor) {
          element.style.left = `${Math.max(
            8,
            Math.min(
              anchor.left,
              innerWidth - element.offsetWidth - 8,
            ),
          )}px`
          element.style.top = `${below ? anchor.bottom + 6 : Math.max(
            8,
            anchor.top - element.offsetHeight - 6,
          )}px`
        }
      }

      position()
      element.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus()
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

      const outside = (event: PointerEvent) => {
        if (!root.current?.contains(event.target as Node)) {
          setOpen(false)
        }
      }

      document.addEventListener(
        'pointerdown',
        outside,
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
        document.removeEventListener(
          'pointerdown',
          outside,
        )
      }
    },
    [
      open,
      below,
    ],
  )

  return (
    <div
      className={`popover ${className}`}
      data-key-scope="overlay"
      ref={root}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); close()
        }
      }}
    >
      <Button
        // eslint-disable-next-line pnyx/object-params -- React ref callback.
        ref={element => {
          button.current = element

          if (triggerRef) {
            triggerRef.current = element
          }
        }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)}
      >{trigger}
      </Button>
      {open && (
        <div
          ref={panel}
          id={id}
          className="popover-panel"
          popover="manual"
          role="dialog"
          aria-label={label}
        >{children({ close })}
        </div>
      )}
    </div>
  )
}
