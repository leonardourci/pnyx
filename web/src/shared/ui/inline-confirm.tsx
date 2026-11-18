import { useId, useRef, useState } from 'react'
import { Button, useBusy } from './controls.tsx'

// A destructive action that asks in place before it runs. confirm resolves false to stay open.
export function InlineConfirm({
  label,
  trigger: triggerText = 'Delete',
  action,
  message,
  disabled,
  confirm,
}: {
  label: string
  trigger?: string
  action: string
  message: string
  disabled: boolean
  confirm(): Promise<boolean>
}) {
  const [
      open,
      setOpen,
    ] = useState(false), [
      busy,
      run,
    ] = useBusy(), id = useId()
  const trigger = useRef<HTMLButtonElement>(null)

  const cancel = () => {
    setOpen(false); trigger.current?.focus()
  }

  return (
    <div
      onKeyDown={e => {
        if (e.key === 'Escape' && open && !busy && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.stopPropagation(); cancel()
        }
      }}
    >
      <Button
        ref={trigger}
        className="inline-confirm-trigger in-[.settings-page]:min-h-7 in-[.settings-page]:gap-1.5 in-[.settings-page]:py-1.25 in-[.settings-page]:px-2.25 in-[.settings-page]:border in-[.settings-page]:border-line in-[.settings-page]:rounded-md in-[.settings-page]:bg-raised in-[.settings-page]:text-ui"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {triggerText}
      </Button>
      {open && (
        <div
          id={id}
          className="inline-confirm"
        >
          <p>{message}</p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busy || disabled}
              onClick={() => run({
                save: async () => {
                  if (await confirm()) {
                    setOpen(false)
                  }
                },
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
