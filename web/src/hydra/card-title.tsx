import type { HTMLAttributes } from 'react'
import { Icon } from '../components/ui/icon.tsx'

// A div with the button role rather than a <button>, so the card can still be dragged by its title.
export function CardTitle({
  title,
  briefOpen,
  toggleBrief,
  open,
  ...props
}: {
  title: string
  briefOpen: boolean
  toggleBrief(): void
  open(): void
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className="button card-open"
      role="button"
      aria-expanded={briefOpen}
      aria-description="Space shows the brief, Enter opens the task"
      onClick={event => {
        event.stopPropagation(); toggleBrief()
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
          return
        }

        if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation(); open()
        } else if (event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); toggleBrief()
        }
      }}
    >
      <span className="card-brief-chevron" aria-hidden="true"><Icon name="chevron_right" size={13} /></span>
      {title}
    </div>
  )
}
