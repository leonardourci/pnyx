import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './controls.tsx'

export function ConfirmationDialog({
  title,
  children,
  busy,
  confirm,
  cancel,
}: {
  title: string
  children: ReactNode
  busy: boolean
  confirm(): void
  cancel(): void
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
      className="confirmation-dialog"
      aria-label={title}
      onCancel={e => {
        e.preventDefault()

        if (!busy) {
          cancel()
        }
      }}
    >
      <h2>{title}</h2>
      {children}
      <div className="row">
        <Button variant="primary" disabled={busy} onClick={confirm}>Attach project</Button>
        <Button disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
    </dialog>
  )
}
