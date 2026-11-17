import { useRef, useState } from 'react'
import { clampViewSize } from '#preferences/view.ts'

export function Resize({
  label,
  value,
  min,
  max,
  axis = 'x',
  reverse = false,
  tabIndex = 0,
  onPreview,
  onCommit,
  className = '',
}: {
  className?: string
  label: string
  value: number
  min: number
  max?: number
  axis?: 'x' | 'y'
  reverse?: boolean
  tabIndex?: number
  onPreview({ value }: { value: number | null }): void
  onCommit({ value }: { value: number }): unknown
}) {
  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const current = useRef<number | null>(null)
  const baseline = useRef<number | null>(null)
  const drag = useRef<{
    pointer: number
    start: number
    value: number
  } | null>(null)

  const previewAt = ({ size: n }: { size: number }) => {
    const next = clampViewSize({
      value: n,
      min,
      max,
    })
    current.current = next
    setPreview(next)
    onPreview({ value: next })
  }

  const finish = ({ cancel = false }: { cancel?: boolean } = {}) => {
    const n = current.current
    const startedAt = baseline.current
    baseline.current = null
    current.current = null
    drag.current = null
    setPreview(null)
    onPreview({ value: null })

    if (!cancel && n !== null && startedAt !== null && n !== startedAt) {
      void onCommit({
        value: clampViewSize({
          value: n,
          min,
          max,
        }),
      })
    }
  }

  return (
    <div
      role="separator"
      tabIndex={tabIndex}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max ?? Number.MAX_SAFE_INTEGER}
      aria-valuetext={max === undefined ? `${preview ?? value} pixels` : undefined}
      aria-valuenow={preview ?? value}
      className={`resize resize-${axis} absolute z-6 touch-none outline-none after:absolute after:block after:rounded-sm after:bg-gold after:opacity-70 after:transition-opacity after:duration-fast hover:after:opacity-100 focus:after:opacity-100 ${axis === 'x' ? 'top-[calc(50%-2rem)] -right-1.25 h-16 w-2.25 cursor-col-resize after:top-[calc(50%-1.375rem)] after:left-0.75 after:h-11 after:w-0.5' : 'inset-x-0 -bottom-0.75 h-2.25 cursor-row-resize after:top-0.5 after:left-[calc(50%-1.375rem)] after:h-0.75 after:w-11'} ${className}`}
      onPointerDown={e => {
        if (e.button !== 0 || !e.isPrimary) {
          return
        }

        e.preventDefault()
        e.currentTarget.focus()
        e.currentTarget.setPointerCapture(e.pointerId)
        baseline.current = value
        drag.current = {
          pointer: e.pointerId,
          start: axis === 'x' ? e.clientX : e.clientY,
          value,
        }
      }}
      onPointerMove={e => {
        const captured = drag.current?.pointer === e.pointerId
          && e.currentTarget.hasPointerCapture(e.pointerId)

        if (drag.current && captured && e.buttons === 1) {
          const position = axis === 'x' ? e.clientX : e.clientY
          const delta = (position - drag.current.start) * (reverse ? -1 : 1)
          previewAt({ size: drag.current.value + delta })
        }
      }}
      onPointerUp={e => {
        const captured = drag.current?.pointer === e.pointerId
          && e.currentTarget.hasPointerCapture(e.pointerId)

        if (captured) {
          finish({})
        }
      }}
      onPointerCancel={e => {
        if (drag.current?.pointer === e.pointerId) {
          finish({ cancel: true })
        }
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          finish({ cancel: true })
        }
      }}
      onBlur={() => finish({ cancel: drag.current !== null })}
      onKeyDown={e => {
        if (e.key === 'Escape' && baseline.current !== null) {
          e.preventDefault(); e.stopPropagation(); finish({ cancel: true })

          return
        }

        if (drag.current) {
          return
        }

        const keys = axis === 'x' ? [
          'ArrowLeft',
          'ArrowRight',
        ] : [
          'ArrowUp',
          'ArrowDown',
        ]

        if (![
          ...keys,
          'Home',
          ...(max === undefined ? [] : ['End']),
        ].includes(e.key)) {
          return
        }

        e.preventDefault(); e.stopPropagation()

        if (baseline.current === null) {
          baseline.current = value
        }

        previewAt({ size: e.key === 'Home' ? min : e.key === 'End' && max !== undefined ? max : (current.current ?? value) + (e.key === keys[1] ? 1 : -1) * (reverse ? -1 : 1) * (e.shiftKey ? 32 : 8) })
      }}
      onKeyUp={e => {
        if (!drag.current && [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
        ].includes(e.key)) {
          finish({ })
        }
      }}
    />
  )
}
