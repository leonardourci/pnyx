import { DisclosureChevron } from './disclosure-chevron.tsx'
import { Icon } from './icon.tsx'
import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { sliderValue } from './slider-value.ts'
import { MenuOption } from './menu-option.tsx'

export function Button({
  className = '',
  variant = 'quiet',
  ...props
}: ComponentProps<'button'> & { variant?: 'quiet' | 'primary' | 'surface' | 'menu-choice' }) {
  const appearance = {
    'menu-choice': 'bg-transparent border-transparent flex-1 min-w-0 justify-start min-h-9 gap-2 p-1.75 text-ui text-left [&>span]:flex-1 [&>span]:min-w-0 [&>span]:wrap-anywhere [&>svg]:shrink-0',
    quiet: '[:where(&)]:bg-transparent [:where(&)]:border-transparent enabled:hover:bg-hover',
    surface: 'bg-raised border-control enabled:hover:bg-hover',
    primary: 'bg-gold-fill text-gold-ink border-gold-fill enabled:hover:bg-hover enabled:hover:brightness-108',
  }[variant]

  return <button type="button" className={`button ${variant} inline-flex items-center justify-center [:where(&)]:gap-1.5 [:where(&)]:rounded-md border [:where(&)]:px-2.25 [:where(&)]:py-1.5 [:where(&)]:min-h-7.5 [:where(&)]:text-[length:inherit] leading-[inherit] ${appearance} ${className}`} {...props} />
}

const INPUT_CLASSES = 'input [:where(&)]:appearance-none [:where(&)]:border [:where(&)]:border-control [:where(&)]:rounded-md [:where(&)]:px-2.25 [:where(&)]:py-1.75 [:where(&)]:min-w-0 [:where(&)]:text-ui [:where(&)]:leading-normal placeholder:text-muted placeholder:opacity-85 [&::-webkit-search-cancel-button]:appearance-none'

export function Input({ ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`${INPUT_CLASSES} [:where(&)]:bg-surface ${props.className ?? ''}`} />
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
  return <textarea {...props} className={`${INPUT_CLASSES} textarea [:where(&)]:bg-background [:where(&)]:w-full [:where(&)]:h-full [:where(&)]:min-h-12 [:where(&)]:max-h-textarea [:where(&)]:resize-y [:where(&)]:overflow-y-auto ${props.className ?? ''}`} />
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
  caption,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange({ value }: { value: boolean }): unknown
  // Leaves the visible name to the row around it; the switch keeps it as its accessible name.
  quiet?: boolean
  // Short visible text beside the track, such as On, when the row around it already names the setting.
  caption?: string
  disabled?: boolean
}) {
  const [
    busy,
    run,
  ] = useBusy()

  return (
    <Button
      className="switch-label group/switch justify-start text-muted py-1.25 px-0 text-meta in-[.settings-page]:gap-2 in-[.settings-page]:p-0 in-[.settings-page]:text-ink in-[.settings-page]:text-ui in-[.settings-page]:disabled:cursor-not-allowed"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy}
      disabled={disabled || busy}
      onClick={() => run({ save: () => onChange({ value: !checked }) })}
    >
      <span className="switch-track w-7 h-4 p-0.5 border border-control rounded-card bg-hover shrink-0 in-[.settings-page]:bg-raised group-aria-checked/switch:bg-gold-fill group-aria-checked/switch:border-gold-line">
        <span className="block size-2.5 rounded-full bg-muted transition-transform ease-ui duration-100 in-[.settings-page]:bg-control in-[.settings-page]:duration-150 group-aria-checked/switch:translate-x-2.75 group-aria-checked/switch:bg-gold-ink in-[.settings-page]:group-aria-checked/switch:translate-x-3" />
      </span>
      {caption ?? (!quiet && label)}
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
    <div className="select relative min-w-25 [&>.button]:w-full [&>.button]:justify-between [&>.button]:gap-5 [&>.button]:text-left" ref={root}>
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
        <DisclosureChevron expanded={open} />
      </Button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className="select-menu absolute top-[calc(100%+--spacing(1.25))] left-0 min-w-full w-max max-w-select max-h-70 overflow-auto p-1 rounded-control bg-raised border border-line shadow-menu z-30 [&_.menu-option]:px-2.5 [&_.menu-option]:py-2"
        >
          {options.map((
            o,
            n,
          ) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[n - 1]?.group && <div className="select-group pt-2 px-2.5 pb-0.5 text-muted text-meta font-semibold first:pt-0.5" role="presentation">{o.group}</div>}
              <MenuOption
                id={`${id}-${n}`}
                aria-label={o.label}
                data-group={o.group}
                tabIndex={-1}
                selected={o.value === value}
                active={active === n}
                disabled={disabled}
                onPointerMove={() => setActive(n)}
                onPointerDown={() => {
                  hold.current.done = false
                  release()

                  if (onDefault && !disabled) {
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
                onClick={({
                  metaKey,
                  ctrlKey,
                }) => {
                  if (hold.current.done) {
                    hold.current.done = false
                  } else if (onDefault && (metaKey || ctrlKey)) {
                    makeDefault({ position: n })
                  } else {
                    choose({ position: n })
                  }
                }}
              >
                <span className="select-option inline-flex items-center gap-2 min-w-0">
                  {o.icon && <Icon name={o.icon} size={iconSize} />}
                  {o.label}
                  {onDefault && o.value === defaultValue && (
                    <span
                      className="select-default inline-flex text-gold"
                      role="img"
                      aria-label="Default"
                      title="The default"
                    >
                      <Icon name="pinned" size={12} />
                    </span>
                  )}
                </span>
                <span aria-hidden="true">{o.value === value && <Icon name="check" size={14} />}</span>
              </MenuOption>
            </Fragment>
          ))}
          {onDefault && <p className="select-hint mt-1 mx-0 mb-0 pt-1.5 px-2.5 pb-0.5 border-t border-line text-muted text-meta">{MOD}-click or hold to pick it and make it the default</p>}
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
  onSlide,
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
  onSlide?({ value }: { value?: number }): void
}) {
  if (slider) {
    return (
      <NumberSlider
        onSlide={onSlide}
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
    <div className="number-field flex items-center justify-between gap-2 mt-4 text-ui" aria-busy={busy}>
      <label htmlFor={id}>{label}</label>
      <span className="number-control inline-flex items-center gap-0.75 shrink-0 [&>.input]:w-12 [&>.input]:text-center [&>.input]:text-ui [&>span]:text-muted [&>span]:text-ui [&>.button]:text-pane [&>.button]:px-1.5 [&>.button]:py-1">
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
  onSlide,
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
  // The value under the thumb while it moves, then undefined once it is let go.
  onSlide?({ value }: { value?: number }): void
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
      onSlide?.({ value: undefined })
    }
  }

  return (
    <div className="slider-field flex items-center gap-2.5 w-full" aria-busy={busy}>
      <span className="slider-track relative flex-1 flex items-center h-5.5" style={{ '--fill': share({ at: shown }) } as CSSProperties}>
        <input
          className="appearance-none w-full h-5.5 m-0 bg-transparent cursor-pointer focus-visible:outline-2 focus-visible:outline-gold-line focus-visible:outline-offset-2 focus-visible:rounded-sm"
          type="range"
          aria-label={label}
          min={min}
          max={sliderMax}
          step={step}
          value={shown}
          onChange={event => {
            setSliding(Number(event.target.value))
            onSlide?.({ value: Number(event.target.value) })
          }}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
        />
        {tick && <span className="slider-tick absolute top-3.75 w-px h-1.5 bg-muted -translate-x-1/2 pointer-events-none after:content-[attr(data-l)] after:absolute after:top-1.25 after:left-1/2 after:-translate-x-1/2 after:text-muted after:text-meta after:whitespace-nowrap" style={{ left: tick }} data-l="default" />}
      </span>
      <span className="slider-box flex items-center border border-line rounded-md bg-surface focus-within:border-gold-line">
        <Input
          id={id}
          className="slider-number w-16 h-7 py-1 px-1.5 border-0 bg-transparent text-right text-ui tabular-nums shadow-none"
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
        {unit && <label htmlFor={id} className="slider-unit pr-1.75 text-muted text-meta">{unit}</label>}
      </span>
    </div>
  )
}

export const DATE_EDITOR = 'reminder-editor flex flex-col gap-2 mt-2.5 p-2.5 border border-line rounded-lg bg-surface [&_[role=alert]]:text-red'
