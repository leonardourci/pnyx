import type { HTMLAttributes } from 'react'
import { Icon } from '#web-shared/ui/icon.tsx'

// A div with the button role rather than a <button>, so the card can still be dragged by its title.
export function CardTitle({
  title,
  expanded,
  open,
  ...props
}: {
  title: string
  expanded: boolean
  open(): void
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className="button card-open"
      role="button"
      aria-expanded={expanded}
      aria-description="Enter or Space opens or folds the task, F2 or Command/Control+E edits"
      onClick={event => {
        event.stopPropagation(); open()
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
          return
        }

        if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation(); open()
        } else if (event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); open()
        }
      }}
    >
      {expanded && <span className="card-brief-chevron" aria-hidden="true"><Icon name="chevron_right" size={13} /></span>}
      {title}
    </div>
  )
}
