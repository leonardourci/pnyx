import { useEffect, useId, useState, type CSSProperties } from 'react'
import { Input, useBusy } from './controls.tsx'
import { sliderValue } from './slider-value.ts'

// A number as a slider and a number box kept in step. The box also takes values past the slider's end, up to max.
export function SliderField({
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
