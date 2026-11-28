import type { HTMLAttributes } from 'react'

// A div with the button role rather than a <button>, so the card can still be dragged by its title.
export function CardTitle({
  title,
  expanded,
  open,
  ...props
}: {
  title: string
  expanded: boolean
  open({ pointer }: { pointer: boolean }): void
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className="button card-open block min-h-0 w-full min-w-0 flex-1 cursor-pointer touch-none p-0 text-left text-ui leading-detail font-medium group-[.selected]/card:font-semibold group-[.selected]/card:whitespace-normal group-[:not(.selected)]/card:truncate max-phone:touch-pan-y"
      role="button"
      aria-expanded={expanded}
      aria-description="Enter or Space opens or folds the task, F2 or Command/Control+E edits"
      onClick={event => {
        event.stopPropagation(); open({ pointer: event.detail > 0 })
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
          return
        }

        if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation(); open({ pointer: false })
        } else if (event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); open({ pointer: false })
        }
      }}
    >
      {title}
    </div>
  )
}
