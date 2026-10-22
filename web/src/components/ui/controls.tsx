import { Icon } from './icon.tsx'
import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react'

export function Button({
  className = '',
  variant = 'quiet',
  ...props
}: ComponentProps<'button'> & { variant?: 'quiet' | 'primary' | 'surface' }) {
  return <button type="button" className={`button ${variant} ${className}`} {...props} />
}

export function Input({ ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />
}

export function Textarea({ ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />
}

export function useBusy(): [boolean, ({ save }: { save: () => unknown }) => void] {
  const [
      busy,
      setBusy,
    ] = useState(false), running = useRef(false)

  return [
    busy,
    ({ save }) => {
      if (running.current) {
        return
      }

      running.current = true; setBusy(true)
      void Promise.resolve(save()).finally(() => {
        running.current = false; setBusy(false)
      })
    },
  ]
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange({ value }: { value: boolean }): unknown
}) {
  const [
    busy,
    run,
  ] = useBusy()

  return (
    <Button
      className="switch-label"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy}
      onClick={() => run({ save: () => onChange({ value: !checked }) })}
    >
      <span className="switch-track">
        <span />
      </span>
      {label}
    </Button>
  )
}

export interface Option {
  value: string
  label: string
  icon?: string
  // Consecutive options of one group sit under its heading.
  group?: string
}

const HOLD_MS = 500
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  display,
  title,
  icon,
  defaultValue,
  onDefault,
}: {
  label: string
  value: string
  options: Option[]
  onChange({ value }: { value: string }): void
  disabled?: boolean
  display?: ReactNode
  title?: string
  // Shown before the label; otherwise the chosen option's own icon.
  icon?: string
  // Mod+click or a long press on an option picks it and makes it the default.
  defaultValue?: string
  onDefault?({ value }: { value: string }): void
}) {
  const [
      open,
      setOpen,
    ] = useState(false), [
      active,
      setActive,
    ] = useState(0)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId()
  const hold = useRef<{
    timer?: ReturnType<typeof setTimeout>
    done: boolean
  }>({ done: false })
  const chosen = options.find(o => o.value === value)
  const shown = icon ?? chosen?.icon
  useEffect(
    () => {
      if (!open) {
        return
      }

      const close = (e: PointerEvent) => {
        if (!root.current?.contains(e.target as Node)) {
          setOpen(false)
        }
      }

      document.addEventListener(
        'pointerdown',
        close,
      )

      return () => document.removeEventListener(
        'pointerdown',
        close,
      )
    },
    [open],
  )

  useEffect(
    () => {
      if (open) {
        document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
      }
    },
    [
      open,
      active,
      id,
    ],
  )

  const choose = ({ position: n }: { position: number }) => {
    if (options[n]) {
      onChange({ value: options[n].value })
    }

    setOpen(false); trigger.current?.focus()
  }

  // Making an option the default also picks it.
  const makeDefault = ({ position: n }: { position: number }) => {
    if (options[n] && onDefault) {
      onChange({ value: options[n].value })
      onDefault({ value: options[n].value })
    }

    setOpen(false); trigger.current?.focus()
  }

  const release = () => clearTimeout(hold.current.timer)

  return (
    <div className="select" ref={root}>
      <Button
        ref={trigger}
        variant="surface"
        disabled={disabled}
        title={title}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setActive(Math.max(
            0,
            options.findIndex(o => o.value === value),
          )); setOpen(!open)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape' && open) {
            e.preventDefault(); e.stopPropagation(); setOpen(false)
          } else if ([
            'ArrowDown',
            'ArrowUp',
            'Home',
            'End',
          ].includes(e.key)) {
            e.preventDefault(); setOpen(true); setActive(n => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : Math.max(
              0,
              Math.min(
                options.length - 1,
                n + (e.key === 'ArrowDown' ? 1 : -1),
              ),
            ))
          } else if (open && e.key === 'Enter' && onDefault && (e.metaKey || e.ctrlKey)) {
            e.preventDefault(); makeDefault({ position: active })
          } else if (open && e.key === 'Enter') {
            e.preventDefault(); choose({ position: active })
          } else if (e.key === 'Tab') {
            setOpen(false)
          }
        }}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
      >
        {shown && <Icon name={shown} size={14} />}
        {display ?? chosen?.label ?? label}
        <Icon name="chevron_down" size={14} />
      </Button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className="select-menu"
        >
          {options.map((
            o,
            n,
          ) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[n - 1]?.group && <div className="select-group" role="presentation">{o.group}</div>}
              <div
                id={`${id}-${n}`}
                role="option"
                data-group={o.group}
                tabIndex={-1}
                aria-selected={o.value === value}
                className={active === n ? 'active' : ''}
                onPointerMove={() => setActive(n)}
                onPointerDown={() => {
                  hold.current.done = false
                  release()

                  if (onDefault) {
                    hold.current.timer = setTimeout(
                      () => {
                        hold.current.done = true; makeDefault({ position: n })
                      },
                      HOLD_MS,
                    )
                  }
                }}
                onPointerUp={release}
                onPointerLeave={release}
                onClick={event => {
                  if (hold.current.done) {
                    hold.current.done = false
                  } else if (onDefault && (event.metaKey || event.ctrlKey)) {
                    makeDefault({ position: n })
                  } else {
                    choose({ position: n })
                  }
                }}
              >
                <span className="select-option">
                  {o.icon && <Icon name={o.icon} size={14} />}
                  {o.label}
                  {onDefault && o.value === defaultValue && (
                    <span
                      className="select-default"
                      role="img"
                      aria-label="Default"
                      title="The default"
                    >
                      <Icon name="pinned" size={12} />
                    </span>
                  )}
                </span>
                <span aria-hidden="true">{o.value === value && <Icon name="check" size={14} />}</span>
              </div>
            </Fragment>
          ))}
          {onDefault && <p className="select-hint">{MOD}-click or hold to pick it and make it the default</p>}
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
  onChange({ value }: { value: number }): unknown
}) {
  const id = useId(), [
    busy,
    run,
  ] = useBusy()
  const onChange = ({ next: n }: { next: number }) => run({ save: () => save({ value: n }) })
  const [
    draft,
    setDraft,
  ] = useState(String(value))
  useEffect(
    () => setDraft(String(value)),
    [value],
  )

  return (
    <div className="number-field" aria-busy={busy}>
      <label htmlFor={id}>{label}</label>
      <span className="number-control">
        <Button
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange({
            next: Math.max(
              min,
              value - step,
            ),
          })}
        ><Icon name="minus" size={14} />
        </Button>
        <Input
          id={id}
          aria-label={label}
          inputMode="numeric"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft); setDraft(String(value))

            if (!busy && Number.isInteger(n) && n >= min && n <= max && n !== value) {
              onChange({ next: n })
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
        <span>px</span>
        <Button
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => onChange({
            next: Math.min(
              max,
              value + step,
            ),
          })}
        ><Icon name="plus" size={14} />
        </Button>
      </span>
    </div>
  )
}
