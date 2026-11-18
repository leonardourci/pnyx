import { ICON_SIZE } from '#web-shared/icons.tsx'
import { OverlaySurface } from './overlay-surface.tsx'
import { useLayoutEffect, useId, useRef, type ReactNode, type CSSProperties } from 'react'
import { motion } from 'motion/react'

import { IconButton } from './icon-button.tsx'

const AnimatedOverlaySurface = motion.create(OverlaySurface)

export function Dialog({
  title,
  className = '',
  actions,
  layoutId,
  style,
  close,
  children,
}: {
  title: ReactNode
  className?: string
  layoutId?: string
  style?: CSSProperties
  // Buttons for the dialog's subject, shown before Close.
  actions?: ReactNode
  close(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  // A text selection dragged out of the panel ends on the backdrop; only a press there closes.
  const pressed = useRef<EventTarget | null>(null)
  useLayoutEffect(
    () => {
      const element = dialog.current

      if (element?.open) {
        element.close()
      }

      element?.showModal()

      return () => element?.close()
    },
    [],
  )

  return (
    <AnimatedOverlaySurface
      layoutScroll
      open={!!layoutId}
      layoutId={layoutId}
      initial={false}
      exit={{ opacity: 0 }}
      style={style}
      ref={dialog}
      aria-labelledby={heading}
      className={className}
      data-key-scope="overlay"
      // eslint-disable-next-line pnyx/object-params -- React owns the dialog event signature.
      onKeyDown={e => {
        if (e.key === 'Tab') {
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
            .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
          const first = controls[0]
          const last = controls.at(-1)
          const boundary = e.shiftKey ? first : last
          const destination = e.shiftKey ? last : first

          if (document.activeElement === boundary && destination) {
            e.preventDefault()
            destination.focus()
          }
        }

        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.stopPropagation(); close()
        }
      }}
      // eslint-disable-next-line pnyx/object-params -- React owns the dialog event signature.
      onCancel={e => {
        e.preventDefault(); close()
      }}
      // eslint-disable-next-line pnyx/object-params -- React owns the dialog event signature.
      onMouseDown={e => {
        pressed.current = e.target
      }}
      // eslint-disable-next-line pnyx/object-params -- React owns the dialog event signature.
      onClick={e => {
        if (e.target === e.currentTarget && pressed.current === e.currentTarget) {
          close()
        }
      }}
    >
      <header className="dialog-head flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-line [&>h2]:flex-1 [&>h2]:font-brand">
        <h2 id={heading}>{title}</h2>
        {actions}
        <IconButton
          size="small"
          icon="close"
          iconSize={ICON_SIZE.inline}
          label="Close"
          onClick={close}
        />
      </header>
      {children}
    </AnimatedOverlaySurface>
  )
}
