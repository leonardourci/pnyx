import { useId, useRef, useState } from 'react'
import { Button, useBusy } from './controls.tsx'

// A destructive action that asks in place before it runs. confirm resolves false to stay open.
export function InlineConfirm({ label, action, message, disabled, confirm }: {
  label: string
  action: string
  message: string
  disabled: boolean
  confirm(): Promise<boolean>
}) {
  const [open, setOpen] = useState(false), [busy, run] = useBusy(), id = useId()
  const trigger = useRef<HTMLButtonElement>(null)

  const cancel = () => {
    setOpen(false); trigger.current?.focus()
  }

  return (
    <div>
      <Button
        ref={trigger}
        className="inline-confirm-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        Delete
      </Button>
      {open && (
        <div
          id={id}
          className="inline-confirm"
          onKeyDown={e => {
            if (e.key === 'Escape' && !busy) {
              e.stopPropagation(); cancel()
            }
          }}
        >
          <p>{message}</p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busy || disabled}
              onClick={() => run(async () => {
                if (await confirm()) {
                  setOpen(false)
                }
              })}
            >
              {action}
            </Button>
            <Button disabled={busy} onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
