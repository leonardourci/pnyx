import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'

export function Button({ className = '', variant = 'quiet', ...props }: ComponentProps<'button'> & { variant?: 'quiet' | 'primary' | 'surface' }) {
  return <button type="button" className={`button ${variant} ${className}`} {...props} />
}

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />
}

export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />
}

export function useBusy(): [boolean, (save: () => unknown) => void] {
  const [busy, setBusy] = useState(false), running = useRef(false)

  return [busy, save => {
    if (running.current) {
      return
    }

    running.current = true; setBusy(true)
    void Promise.resolve(save()).finally(() => {
      running.current = false; setBusy(false)
    })
  }]
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(value: boolean): unknown
}) {
  const [busy, run] = useBusy()

  return (
    <Button
      className="switch-label"
      role="switch"
      aria-checked={checked}
      aria-busy={busy}
      onClick={() => run(() => onChange(!checked))}
    >
      <span className="switch-track"><span /></span>
      {label}
    </Button>
  )
}

export interface Option { value: string; label: string }

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: Option[]
  onChange(value: string): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId()
  useEffect(() => {
    if (!open) {
      return
    }

    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', close)

    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const choose = (n: number) => {
    if (options[n]) {
      onChange(options[n].value)
    }

    setOpen(false); trigger.current?.focus()
  }

  return (
    <div className="select" ref={root}>
      <Button
        ref={trigger}
        variant="surface"
        disabled={disabled}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setActive(Math.max(0, options.findIndex(o => o.value === value))); setOpen(!open)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape' && open) {
            e.preventDefault(); e.stopPropagation(); setOpen(false)
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); setOpen(true); setActive(n => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (open && e.key === 'Enter') {
            e.preventDefault(); choose(active)
          } else if (e.key === 'Tab') {
            setOpen(false)
          }
        }}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
      >
        {options.find(o => o.value === value)?.label ?? label}
        <span aria-hidden="true">⌄</span>
      </Button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className="select-menu"
        >
          {options.map((o, n) => (
            <div
              key={o.value}
              id={`${id}-${n}`}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              className={active === n ? 'active' : ''}
              onPointerMove={() => setActive(n)}
              onClick={() => choose(n)}
            >
              {o.label}
              <span aria-hidden="true">{o.value === value ? '✓' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 8,
  onChange: save,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange(value: number): unknown
}) {
  const id = useId(), [busy, run] = useBusy()
  const onChange = (n: number) => run(() => save(n))
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  return (
    <div className="number-field" aria-busy={busy}>
      <label htmlFor={id}>{label}</label>
      <span className="number-control">
        <Button aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</Button>
        <Input
          id={id}
          aria-label={label}
          inputMode="numeric"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft); setDraft(String(value))

            if (!busy && Number.isInteger(n) && n >= min && n <= max && n !== value) {
              onChange(n)
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
        <span>px</span>
        <Button aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</Button>
      </span>
    </div>
  )
}
