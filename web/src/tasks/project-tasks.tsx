import { Fragment, type ReactNode } from 'react'
import type { Card } from '#tasks/model.ts'

export function ProjectTasks({
  items,
  singleColumn = false,
  render,
}: {
  items: Card[]
  singleColumn?: boolean
  render({ card }: { card: Card }): ReactNode
}) {
  const className = singleColumn ? 'flex w-full flex-col gap-2' : 'flex w-full flex-wrap items-start gap-2'

  return (
    <div data-scroll-content className={className}>
      {items.map(card => <Fragment key={card.key}>{render({ card })}</Fragment>)}
    </div>
  )
}
