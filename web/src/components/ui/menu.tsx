import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './controls.tsx'

export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }

    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', outside)

    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

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
      >⋯
      </Button>
      {open && (
        <div
          className="menu-items"
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

export function DeleteItem({ label, disabled, refusal, confirm }: {
  label: string
  disabled?: boolean
  refusal?: string
  confirm(): Promise<unknown>
}) {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false)

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
