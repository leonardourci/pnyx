import { Icon } from './icon.tsx'
import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { sliderValue } from './slider-value.ts'

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

// A native button is an atomic inline box; a text token must wrap with the words around it.
export function InlineButton({
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<'span'>, 'onClick'> & {
  disabled?: boolean
  onClick?(): void
}) {
  return (
    <span
      {...props}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={event => {
        event.stopPropagation()

        if (!disabled) {
          onClick?.()
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation()

          if (!disabled) {
            onClick?.()
          }
        }
      }}
    />
  )
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
  quiet = false,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange({ value }: { value: boolean }): unknown
  // Leaves the visible name to the row around it; the switch keeps it as its accessible name.
  quiet?: boolean
  disabled?: boolean
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
      disabled={disabled}
      onClick={() => run({ save: () => onChange({ value: !checked }) })}
    >
      <span className="switch-track">
        <span />
      </span>
      {!quiet && label}
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
  defaultValue,
  onDefault,
  iconSize = 14,
}: {
  label: string
  value: string
  options: Option[]
  onChange({ value }: { value: string }): void
  disabled?: boolean
  display?: ReactNode
  title?: string
  // Mod+click or a long press on an option picks it and makes it the default.
  defaultValue?: string
  onDefault?({ value }: { value: string }): void
  iconSize?: number
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
        {chosen?.icon && <Icon name={chosen.icon} size={iconSize} />}
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
                  {o.icon && <Icon name={o.icon} size={iconSize} />}
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

// With slider, the number is a slider and a box kept in step, named by the row around it; the box also takes values past the slider's end, up to max.
export function NumberField({
  label,
  value,
  min,
  max,
  step = 8,
  slider,
  onChange: save,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  slider?: {
    max: number
    // The default, marked with a tick on the slider.
    initial?: number
    unit?: string
  }
  onChange({ value }: { value: number }): unknown
}) {
  if (slider) {
    return (
      <NumberSlider
        label={label}
        value={value}
        min={min}
        max={max}
        sliderMax={slider.max}
        step={step}
        unit={slider.unit}
        initial={slider.initial}
        onChange={save}
      />
    )
  }

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

function NumberSlider({
  label,
  value,
  min,
  max,
  sliderMax = max,
  step = 1,
  unit,
  initial,
  onChange: save,
}: {
  label: string
  value: number
  min: number
  max: number
  sliderMax?: number
  step?: number
  unit?: string
  // The default, marked with a tick on the slider.
  initial?: number
  onChange({ value }: { value: number }): unknown
}) {
  const id = useId()
  const [
    busy,
    run,
  ] = useBusy()
  const [
    draft,
    setDraft,
  ] = useState(String(value))
  const [
    sliding,
    setSliding,
  ] = useState<number>()
  useEffect(
    () => setDraft(String(value)),
    [value],
  )
  const shown = sliding ?? Math.min(
    value,
    sliderMax,
  )
  const share = ({ at }: { at: number }) => `${(at - min) / (sliderMax - min) * 100}%`
  const tick = initial === undefined || initial > sliderMax ? undefined : share({ at: initial })

  const commit = ({ text }: { text: string }) => {
    const next = sliderValue({
      text,
      value,
      min,
      max,
    })

    if (!busy && next !== undefined) {
      run({ save: () => save({ value: next }) })
    }
  }

  const release = () => {
    if (sliding !== undefined) {
      commit({ text: String(sliding) })
      setSliding(undefined)
    }
  }

  return (
    <div className="slider-field" aria-busy={busy}>
      <span className="slider-track" style={{ '--tick': tick } as CSSProperties} data-tick={tick ? '' : undefined}>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={sliderMax}
          step={step}
          value={shown}
          onChange={event => setSliding(Number(event.target.value))}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
        />
      </span>
      <Input
        id={id}
        className="slider-number"
        aria-label={`${label} value`}
        inputMode="numeric"
        value={sliding === undefined ? draft : String(sliding)}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          commit({ text: draft })
          setDraft(String(value))
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
      />
      {unit && <label htmlFor={id} className="slider-unit">{unit}</label>}
    </div>
  )
}
