import { useEffect, useRef, useState } from 'react'
import { useBusy } from './controls.tsx'

export function Resize({ label, value, min, max, axis = 'x', reverse = false, onPreview, onCommit }: { label: string; value: number; min: number; max: number; axis?: 'x' | 'y'; reverse?: boolean; onPreview(value: number | null): void; onCommit(value: number): unknown }) {
  const [preview, setPreview] = useState<number | null>(null), [busy, run] = useBusy()
  const current = useRef<number | null>(null), drag = useRef<{ start: number; value: number } | null>(null)

  const previewAt = (n: number) => {
    const next = Math.round(Math.max(min, Math.min(max, n))); current.current = next; setPreview(next); onPreview(next)
  }

  const finish = (cancel = false) => {
    const n = current.current; current.current = null; drag.current = null; setPreview(null); onPreview(null)

    if (!cancel && n !== null && n !== value) {
      run(() => onCommit(n))
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
          previewAt(drag.current.value + ((axis === 'x' ? e.clientX : e.clientY) - drag.current.start) * (reverse ? -1 : 1))
        }
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => {
        if (drag.current) {
          finish(true)
        }
      }}
      onBlur={() => finish()}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); finish(true)

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

        previewAt(e.key === 'Home' ? min : e.key === 'End' ? max : (current.current ?? value) + (e.key === keys[1] ? 1 : -1) * (reverse ? -1 : 1) * (e.shiftKey ? 32 : 8))
      }}
      onKeyUp={e => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
          finish()
        }
      }}
    />
  )
}
