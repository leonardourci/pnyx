import { applyRuntimeStyle } from './runtime-style.ts'
import { DisclosureChevron } from './disclosure-chevron.tsx'
import { FloatingPanel } from './floating-panel.tsx'
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from './controls.tsx'

export function Popover({
  label,
  trigger,
  chevronSize,
  children,
  className = '',
  triggerRef,
  below = false,
  disabled = false,
  invalid = false,
  describedBy,
}: {
  label: string
  trigger: ReactNode
  chevronSize?: number
  children({ close }: { close(): void }): ReactNode
  className?: string
  triggerRef?: RefObject<HTMLButtonElement | null>
  // Opens under the trigger, for a trigger near the top of the page.
  below?: boolean
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
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
          applyRuntimeStyle({
            element,
            values: {
              left: Math.max(
                8,
                Math.min(
                  anchor.left,
                  innerWidth - element.offsetWidth - 8,
                ),
              ),
            },
          })
          const above = anchor.top - element.offsetHeight - 6
          const under = anchor.bottom + 6
          const fitsBelow = innerHeight - under >= element.offsetHeight
          const top = fitsBelow && (below || above < 8) ? under : above
          applyRuntimeStyle({
            element,
            values: {
              top: Math.max(
                8,
                Math.min(
                  top,
                  innerHeight - element.offsetHeight - 8,
                ),
              ),
            },
          })
        }
      }

      position()
      const controls = element.querySelectorAll<HTMLElement>('summary, button:not(:disabled), input:not(:disabled)')

      for (const control of controls) {
        control.focus()

        if (document.activeElement === control) {
          break
        }
      }

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
      className={`popover relative min-w-0 ${className}`}
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)}
      >
        {trigger}
        {chevronSize !== undefined && <DisclosureChevron expanded={open} size={chevronSize} />}
      </Button>
      {open && (
        <FloatingPanel
          ref={panel}
          id={id}
          className="popover-panel max-h-popover-height w-floating-panel rounded-card p-3.5"
          popover="manual"
          role="dialog"
          aria-label={label}
        >{children({ close })}
        </FloatingPanel>
      )}
    </div>
  )
}
