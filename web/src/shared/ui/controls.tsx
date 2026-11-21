import { runtimeStyle } from './runtime-style.ts'
import { composing } from '#web-shared/ime.ts'
import { DisclosureChevron } from './disclosure-chevron.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Fragment, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { sliderValue } from './slider-value.ts'
import { MenuOption } from './menu-option.tsx'

export function Button({
  className = '',
  variant = 'quiet',
  ...props
}: ComponentProps<'button'> & { variant?: 'quiet' | 'primary' | 'surface' | 'menu-choice' }) {
  const appearance = {
    'menu-choice': 'min-h-9 min-w-0 flex-1 justify-start gap-2 border-transparent bg-transparent p-1.75 text-left text-ui [&>span]:min-w-0 [&>span]:flex-1 [&>span]:wrap-anywhere [&>svg]:shrink-0',
    quiet: 'enabled:hover:bg-hover [:where(&)]:border-transparent [:where(&)]:bg-transparent',
    surface: 'border-control bg-raised enabled:hover:bg-hover',
    primary: 'border-gold-fill bg-gold-fill text-gold-ink enabled:hover:bg-hover enabled:hover:brightness-108',
  }[variant]

  return <button type="button" className={`button ${variant} inline-flex items-center justify-center border [:where(&)]:min-h-7.5 [:where(&)]:gap-1.5 [:where(&)]:rounded-md [:where(&)]:px-2.25 [:where(&)]:py-1.5 [:where(&)]:text-ui [:where(&)]:leading-question ${appearance} ${className}`} {...props} />
}

const INPUT_CLASSES = 'input placeholder:text-muted placeholder:opacity-85 [:where(&)]:min-w-0 [:where(&)]:appearance-none [:where(&)]:rounded-md [:where(&)]:border [:where(&)]:border-control [:where(&)]:px-2.25 [:where(&)]:py-1.75 [:where(&)]:text-ui [:where(&)]:leading-normal'

function blurOnEnter({
  key,
  currentTarget,
}: KeyboardEvent<HTMLInputElement>) {
  if (key === 'Enter') {
    currentTarget.blur()
  }
}

export function NativeInput({ ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`${INPUT_CLASSES} [:where(&)]:bg-surface ${props.className ?? ''}`} />
}

const lineBreaks = /[\r\n]/g

function singleLine({ text }: { text: string }) {
  return text.replace(
    lineBreaks,
    '',
  )
}

export function Input({
  onChange,
  onKeyDown,
  value,
  defaultValue,
  ...props
}: ComponentProps<'textarea'>) {
  return (
    <Textarea
      {...props}
      aria-multiline={props.role === 'combobox' ? undefined : false}
      value={typeof value === 'string' ? singleLine({ text: value }) : value}
      defaultValue={typeof defaultValue === 'string' ? singleLine({ text: defaultValue }) : defaultValue}
      onChange={event => {
        const field = event.currentTarget
        const breaks = [...field.value.matchAll(lineBreaks)]

        if (breaks.length) {
          const direction = field.selectionDirection

          for (const match of breaks.reverse()) {
            field.setRangeText(
              '',
              match.index,
              match.index + match[0].length,
              'preserve',
            )
          }

          field.selectionDirection = direction
        }

        onChange?.(event)
      }}
      className={`min-h-0 [:where(&)]:bg-surface ${props.className ?? ''}`}
      onKeyDown={event => {
        if (event.key === 'Enter' && composing({ event: event.nativeEvent })) {
          return
        }

        onKeyDown?.(event)

        if (event.key !== 'Enter') {
          return
        }

        const modified = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey
        const submit = !event.defaultPrevented && !modified
        event.preventDefault()

        const form = event.currentTarget.form

        if (!submit || !form) {
          return
        }

        const button = Array.from(form.elements).find(control =>
          (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) && control.type === 'submit')

        if (button instanceof HTMLElement) {
          button.click()
        } else if (form.querySelectorAll('textarea[aria-multiline="false"]').length === 1) {
          form.requestSubmit()
        }
      }}
    />
  )
}

function selectingInlineText({ element }: { element: HTMLElement }) {
  const selection = window.getSelection()

  return selection && !selection.isCollapsed
    && element.contains(selection.anchorNode) && element.contains(selection.focusNode)
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

        if (!disabled && !selectingInlineText({ element: event.currentTarget })) {
          onClick?.()
        }
      }}
      onKeyDown={event => {
        if (selectingInlineText({ element: event.currentTarget })) {
          return
        }

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
  return <textarea {...props} className={`${INPUT_CLASSES} textarea field-sizing-content wrap-anywhere [:where(&)]:min-h-12 [:where(&)]:w-full [:where(&)]:resize-none [:where(&)]:overflow-hidden [:where(&)]:bg-background ${props.className ?? ''}`} />
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
      className="switch-label group/switch justify-start px-0 py-1.25 text-meta text-muted in-[.settings-page]:gap-2 in-[.settings-page]:p-0 in-[.settings-page]:text-ui in-[.settings-page]:text-ink in-[.settings-page]:disabled:cursor-not-allowed"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy}
      disabled={disabled || busy}
      onClick={() => run({ save: () => onChange({ value: !checked }) })}
    >
      <span className="switch-track h-4 w-7 shrink-0 rounded-card border border-control bg-hover p-0.5 group-aria-checked/switch:border-gold-line group-aria-checked/switch:bg-gold-fill in-[.settings-page]:bg-raised">
        <span className="block size-2.5 rounded-full bg-muted transition-transform duration-fast ease-ui group-aria-checked/switch:translate-x-2.75 group-aria-checked/switch:bg-gold-ink in-[.settings-page]:bg-control in-[.settings-page]:duration-base in-[.settings-page]:group-aria-checked/switch:translate-x-3" />
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
  iconSize = ICON_SIZE.inline,
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
          className="select-menu absolute top-control-menu left-0 z-30 max-h-70 w-max max-w-select min-w-full overflow-auto rounded-control border border-line bg-raised p-1 shadow-menu [&_.menu-option]:px-2.5 [&_.menu-option]:py-2"
        >
          {options.map((
            o,
            n,
          ) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[n - 1]?.group && <div className="select-group px-2.5 pt-2 pb-0.5 text-meta font-semibold text-muted first:pt-0.5" role="presentation">{o.group}</div>}
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
                <span className="select-option inline-flex min-w-0 items-center gap-2">
                  {o.icon && <Icon name={o.icon} size={iconSize} />}
                  {o.label}
                  {onDefault && o.value === defaultValue && (
                    <span
                      className="select-default inline-flex text-gold"
                      role="img"
                      aria-label="Default"
                      title="The default"
                    >
                      <Icon name="pinned" size={ICON_SIZE.badge} />
                    </span>
                  )}
                </span>
                <span aria-hidden="true">{o.value === value && <Icon name="check" size={ICON_SIZE.inline} />}</span>
              </MenuOption>
            </Fragment>
          ))}
          {onDefault && <p className="select-hint mx-0 mt-1 mb-0 border-t border-line px-2.5 pt-1.5 pb-0.5 text-meta text-muted">{MOD}-click or hold to pick it and make it the default</p>}
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
    <div className="number-field mt-4 flex items-center justify-between gap-2 text-ui" aria-busy={busy}>
      <label htmlFor={id}>{label}</label>
      <span className="number-control inline-flex shrink-0 items-center gap-0.75 [&>.button]:px-1.5 [&>.button]:py-1 [&>.button]:text-pane [&>.input]:w-12 [&>.input]:text-center [&>.input]:text-ui [&>span]:text-ui [&>span]:text-muted">
        <Button
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange({
            next: Math.max(
              min,
              value - step,
            ),
          })}
        ><Icon name="minus" size={ICON_SIZE.inline} />
        </Button>
        <NativeInput
          id={id}
          aria-label={label}
          inputMode="numeric"
          value={draft}
          onChange={({ target }) => setDraft(target.value)}
          onBlur={() => {
            const n = Number(draft); setDraft(String(value))

            if (!busy && Number.isInteger(n) && n >= min && n <= max && n !== value) {
              onChange({ next: n })
            }
          }}
          onKeyDown={blurOnEnter}
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
        ><Icon name="plus" size={ICON_SIZE.inline} />
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
    <div className="slider-field flex w-full items-center gap-2.5" aria-busy={busy}>
      <span className="slider-track relative flex h-5.5 flex-1 items-center" style={runtimeStyle({ sliderFill: share({ at: shown }) })}>
        <input
          className="m-0 h-5.5 w-full cursor-pointer appearance-none bg-transparent focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-line [&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-sm [&::-moz-range-progress]:bg-gold-fill [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-gold [&::-moz-range-thumb]:bg-surface [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-sm [&::-moz-range-track]:bg-line [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-sm [&::-webkit-slider-runnable-track]:bg-slider-fill [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-gold [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-range"
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
        {tick && <span className="slider-tick pointer-events-none absolute top-3.75 h-1.5 w-px -translate-x-1/2 bg-muted after:absolute after:top-1.25 after:left-1/2 after:-translate-x-1/2 after:text-meta after:whitespace-nowrap after:text-muted after:content-label" style={runtimeStyle({ left: tick })} data-l="default" />}
      </span>
      <span className="slider-box flex items-center rounded-md border border-line bg-surface focus-within:border-gold-line">
        <NativeInput
          id={id}
          className="slider-number h-7 w-16 border-0 bg-transparent px-1.5 py-1 text-right text-ui tabular-nums shadow-none"
          aria-label={`${label} value`}
          inputMode="numeric"
          value={sliding === undefined ? draft : String(sliding)}
          onChange={({ target }) => setDraft(target.value)}
          onBlur={() => {
            commit({ text: draft })
            setDraft(String(value))
          }}
          onKeyDown={blurOnEnter}
        />
        {unit && <label htmlFor={id} className="slider-unit pr-1.75 text-meta text-muted">{unit}</label>}
      </span>
    </div>
  )
}

export const DATE_EDITOR = 'reminder-editor mt-2.5 flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5 [&_[role=alert]]:text-red'
