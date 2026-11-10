import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RichText } from './rich-text.tsx'
import { Icon } from './icon.tsx'
import { Button } from './controls.tsx'

export function Disclosure({
  title,
  children,
  className = '',
  open,
  onToggle,
}: {
  title: ReactNode
  children: ReactNode
  className?: string
  open?: boolean
  onToggle?({ open }: { open: boolean }): void
}) {
  return (
    <details
      className={`disclosure ${className}`}
      open={open}
      onToggle={event => onToggle?.({ open: event.currentTarget.open })}
    >
      <summary contentEditable={false}>
        {title}
        <span className="disclosure-chevron" aria-hidden="true"><Icon name="chevron_right" size={14} /></span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}

// preview: shown while folded, so the rest of text renders only once opened. open and toggle let a caller own the state.
export function CollapsibleText({
  text,
  preview: folded,
  open,
  toggle,
  className = '',
}: {
  text: string
  preview?: string
  open?: boolean
  toggle?(): void
  className?: string
}) {
  const [
      own,
      setOwn,
    ] = useState(false), [
      overflowing,
      setOverflowing,
    ] = useState(false), id = useId()
  const expanded = open ?? own
  const flip = toggle ?? (() => setOwn(!own))
  const shown = expanded || folded === undefined ? text : folded
  const long = overflowing || shown !== text
  const preview = useRef<HTMLDivElement>(null)

  useLayoutEffect(
    () => {
      const element = preview.current

      if (!element || expanded) {
        return
      }

      const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(element)

      return () => observer.disconnect()
    },
    [
      text,
      expanded,
    ],
  )

  return (
    <div className={`collapsible-text ${className}`}>
      <div id={id} ref={preview} className={expanded ? undefined : 'text-preview'}><RichText text={shown} /></div>
      {(long || expanded) && (
        <Button
          contentEditable={false}
          className="show-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={flip}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  )
}
