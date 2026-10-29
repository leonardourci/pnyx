import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

export function Dialog({
  title,
  className = '',
  actions,
  close,
  children,
}: {
  title: ReactNode
  className?: string
  // Buttons for the dialog's subject, shown before Close.
  actions?: ReactNode
  close(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  // A text selection dragged out of the panel ends on the backdrop; only a press there closes.
  const pressed = useRef<EventTarget | null>(null)
  useEffect(
    () => {
      const element = dialog.current
      element?.showModal()

      return () => element?.close()
    },
    [],
  )

  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      className={`dialog ${className}`}
      data-key-scope="overlay"
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.stopPropagation(); close()
        }
      }}
      onCancel={e => {
        e.preventDefault(); close()
      }}
      onMouseDown={e => {
        pressed.current = e.target
      }}
      onClick={e => {
        if (e.target === e.currentTarget && pressed.current === e.currentTarget) {
          close()
        }
      }}
    >
      <header className="dialog-head">
        <h2 id={heading}>{title}</h2>
        {actions}
        <Button className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" size={14} />
        </Button>
      </header>
      {children}
    </dialog>
  )
}
