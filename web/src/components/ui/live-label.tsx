import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Each label stays at least this long, so a burst of quick changes never flashes.
const MIN_SHOWN_MS = 1000
// Matches the leave animation in index.css; the old label is dropped after it.
const LEAVE_MS = 180

// Shows the latest value and swaps to the next with a short rise: the old label fades
// up, the new one rises in and the width eases to fit. A null value empties it, and an
// undefined one keeps what is shown.
export function LiveLabel<Value>({
  value,
  keyOf,
  render,
  done,
}: {
  value: Value | null | undefined
  keyOf({ value }: { value: Value }): string
  render({ value }: { value: Value }): ReactNode
  // The labelled work has finished; the label stays, dimmed, until the next one.
  done?: boolean
}) {
  const [
    shown,
    setShown,
  ] = useState(value ?? null)
  const [
    leaving,
    setLeaving,
  ] = useState<Value | null>(null)
  const [
    width,
    setWidth,
  ] = useState<number>()
  const shownAt = useRef(performance.now())
  const item = useRef<HTMLSpanElement>(null)
  const target = value === undefined ? shown : value
  const key = target === null ? null : keyOf({ value: target })
  const shownKey = shown === null ? null : keyOf({ value: shown })
  // The same label may still change in place, such as a renamed task chip.
  const current = key === shownKey ? target : shown

  useEffect(
    () => {
      if (key === shownKey) {
        return
      }

      const timer = setTimeout(
        () => {
          setLeaving(shown)
          setShown(target)
          shownAt.current = performance.now()
        },
        Math.max(
          0,
          shownAt.current + MIN_SHOWN_MS - performance.now(),
        ),
      )

      return () => clearTimeout(timer)
    },
    // A swap waits on the label's key, not on each new render of the same label.
    [
      key,
      shownKey,
    ],
  )

  useEffect(
    () => {
      if (leaving === null) {
        return
      }

      const timer = setTimeout(
        () => setLeaving(null),
        LEAVE_MS,
      )

      return () => clearTimeout(timer)
    },
    [leaving],
  )

  // The new label's natural width, measured unconstrained before paint; the bubble eases to it.
  useLayoutEffect(
    () => {
      const element = item.current

      if (!element) {
        setWidth(0)

        return
      }

      element.style.maxWidth = 'none'
      element.style.width = 'max-content'
      // Rounded up: a width cut by a fraction of a pixel would end the label in an ellipsis.
      setWidth(Math.ceil(element.getBoundingClientRect().width))
      element.style.maxWidth = ''
      element.style.width = ''
    },
    [shownKey],
  )

  if (current === null && leaving === null) {
    return null
  }

  return (
    <span className="live-label" data-done={done || undefined} style={{ width }}>
      {leaving !== null && (
        <span
          key={`leaving:${keyOf({ value: leaving })}`}
          className="live-label-item"
          data-leaving=""
          aria-hidden="true"
        >
          {render({ value: leaving })}
        </span>
      )}
      {current !== null && (
        <span key={shownKey} ref={item} className="live-label-item">
          {render({ value: current })}
        </span>
      )}
    </span>
  )
}
