import { useRef } from 'react'
import { useBusy } from './controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export interface SegmentedOption {
  value: string
  label: string
  icon?: string
}

const STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
}

// A radio group drawn as joined buttons; ← → move to the next option and choose it.
export function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: SegmentedOption[]
  onChange({ value }: { value: string }): unknown
}) {
  const group = useRef<HTMLDivElement>(null)
  const [
    busy,
    run,
  ] = useBusy()
  const chosen = Math.max(
    0,
    options.findIndex(option => option.value === value),
  )

  const choose = ({ index }: { index: number }) => {
    const option = options[(index + options.length) % options.length]!
    group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[options.indexOf(option)]?.focus()

    if (option.value !== value) {
      run({ save: () => onChange({ value: option.value }) })
    }
  }

  return (
    <div
      ref={group}
      className="segmented inline-flex flex-wrap gap-0.5 rounded-control border border-line bg-raised p-0.5"
      role="radiogroup"
      aria-label={label}
      aria-busy={busy}
      onKeyDown={event => {
        const step = STEPS[event.key]

        if (step) {
          event.preventDefault()
          choose({ index: chosen + step })
        }
      }}
    >
      {options.map((
        option,
        index,
      ) => (
        <button
          key={option.value}
          type="button"
          className="inline-flex min-h-6 cursor-pointer items-center gap-1.25 rounded-compact border-0 bg-transparent px-2.5 py-0.75 text-ui text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-line aria-checked:bg-surface aria-checked:text-ink aria-checked:shadow-segment aria-checked:[&_svg]:text-gold"
          role="radio"
          aria-checked={index === chosen}
          tabIndex={index === chosen ? 0 : -1}
          onClick={() => choose({ index })}
        >
          {option.icon && <Icon name={option.icon} size={ICON_SIZE.inline} />}
          {option.label}
        </button>
      ))}
    </div>
  )
}
