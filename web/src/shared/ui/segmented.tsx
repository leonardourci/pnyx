import { useRef } from 'react'
import { useBusy } from './controls.tsx'

export interface SegmentedOption {
  value: string
  label: string
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
      className="segmented"
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
          role="radio"
          aria-checked={index === chosen}
          tabIndex={index === chosen ? 0 : -1}
          onClick={() => choose({ index })}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
