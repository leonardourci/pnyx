import { useEffect, useRef, useState } from 'react'
import { clampViewSize } from '../../../../src/core/view.ts'
import { useBusy } from './controls.tsx'

export function Resize({ label, value, min, max, axis = 'x', reverse = false, onPreview, onCommit }: { label: string; value: number; min: number; max: number; axis?: 'x' | 'y'; reverse?: boolean; onPreview({ value }: { value: number | null }): void; onCommit({ value }: { value: number }): unknown }) {
  const [preview, setPreview] = useState<number | null>(null), [busy, run] = useBusy()
  const current = useRef<number | null>(null)
  const drag = useRef<{ start: number; value: number } | null>(null)

  const previewAt = ({ size: n }: { size: number }) => {
    const next = clampViewSize({ value: n, min, max })
    current.current = next
    setPreview(next)
    onPreview({ value: next })
  }

  const finish = ({ cancel = false }: { cancel?: boolean } = {}) => {
    const n = current.current
    current.current = null
    drag.current = null
    setPreview(null)
    onPreview({ value: null })

    if (!cancel && n !== null && n !== value) {
      run({ save: () => onCommit({ value: clampViewSize({ value: n, min, max }) }) })
    }
  }

  useEffect(() => () => {
    current.current = null
  }, [])

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={preview ?? value}
      aria-busy={busy}
      className={`resize resize-${axis}`}
      onPointerDown={e => {
        if (e.button !== 0 || busy) {
          return
        }

        e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { start: axis === 'x' ? e.clientX : e.clientY, value }
      }}
      onPointerMove={e => {
        if (drag.current) {
          previewAt({ size: drag.current.value + ((axis === 'x' ? e.clientX : e.clientY) - drag.current.start) * (reverse ? -1 : 1) })
        }
      }}
      onPointerUp={() => finish({ })}
      onPointerCancel={() => finish({ cancel: true })}
      onLostPointerCapture={() => {
        if (drag.current) {
          finish({ cancel: true })
        }
      }}
      onBlur={() => finish({ })}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); finish({ cancel: true })

          return
        }

        const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']

        if (![...keys, 'Home', 'End'].includes(e.key)) {
          return
        }

        e.preventDefault(); e.stopPropagation()

        if (busy) {
          return
        }

        previewAt({ size: e.key === 'Home' ? min : e.key === 'End' ? max : (current.current ?? value) + (e.key === keys[1] ? 1 : -1) * (reverse ? -1 : 1) * (e.shiftKey ? 32 : 8) })
      }}
      onKeyUp={e => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
          finish({ })
        }
      }}
    />
  )
}
