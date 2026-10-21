import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'

// A modal panel with a title bar; Escape, the ✕ and the backdrop close it.
export function Dialog({
  title,
  className = '',
  close,
  children,
}: {
  title: ReactNode
  className?: string
  close(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
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
      className={`dialog ${className}`}
      onCancel={e => {
        e.preventDefault(); close()
      }}
      onClick={e => {
        if (e.target === e.currentTarget) {
          close()
        }
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <Button className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" size={14} />
        </Button>
      </header>
      {children}
    </dialog>
  )
}
