import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Each label stays at least this long, so a burst of quick changes never flashes.
const MIN_SHOWN_MS = 1000

// Swaps labels with a short rise and eases its width to the new one.
export function LiveLabel<Value>({
  value,
  fallback,
  keyOf,
  render,
  dimmed,
}: {
  // null shows the fallback, or nothing; undefined keeps the label already on its way.
  value: Value | null | undefined
  fallback?: Value
  keyOf({ value }: { value: Value }): string
  render({ value }: { value: Value }): ReactNode
  dimmed?({ value }: { value: Value }): boolean
}) {
  const resolved = ({ next }: { next: Value | null }) => next ?? fallback ?? null

  const keyOrNull = ({ next }: { next: Value | null }) => {
    if (next === null) {
      return null
    }

    return keyOf({ value: next })
  }

  const [
    wanted,
    setWanted,
  ] = useState<Value | null>(() => resolved({ next: value ?? null }))
  const [
    shown,
    setShown,
  ] = useState<Value | null>(wanted)
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
  const wantedKey = keyOrNull({ next: wanted })
  const shownKey = keyOrNull({ next: shown })
  const target = value === undefined ? wanted : resolved({ next: value })
  const targetKey = keyOrNull({ next: target })

  // A new label replaces the wanted one only when its key changes, not on every render.
  useEffect(
    () => setWanted(target),
    [targetKey],
  )

  useEffect(
    () => {
      if (wantedKey === shownKey) {
        return
      }

      const hold = shown === null ? 0 : shownAt.current + MIN_SHOWN_MS - performance.now()
      const timer = setTimeout(
        () => {
          setLeaving(shown)
          setShown(wanted)
          shownAt.current = performance.now()
        },
        Math.max(
          0,
          hold,
        ),
      )

      return () => clearTimeout(timer)
    },
    [
      wantedKey,
      shownKey,
    ],
  )

  // The new label's natural width, measured unconstrained before paint.
  useLayoutEffect(
    () => {
      const element = item.current

      if (!element) {
        setWidth(0)

        return
      }

      element.style.maxWidth = 'none'
      element.style.width = 'max-content'
      // Rounded up: a width short by a fraction of a pixel would end the label in an ellipsis.
      setWidth(Math.ceil(element.getBoundingClientRect().width))
      element.style.maxWidth = ''
      element.style.width = ''
    },
    [shownKey],
  )

  const current = targetKey === shownKey ? target : shown

  if (current === null && leaving === null) {
    return null
  }

  const dim = current !== null && !!dimmed?.({ value: current })

  return (
    <span className="live-label" data-done={dim || undefined} style={{ width }}>
      {leaving !== null && (
        <span
          key={`leaving:${keyOf({ value: leaving })}`}
          className="live-label-item"
          data-leaving=""
          aria-hidden="true"
          onAnimationEnd={() => setLeaving(null)}
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
