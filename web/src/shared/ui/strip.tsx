import { useLayoutEffect, useRef, type ReactNode } from 'react'

export function Strip<T>({
  items,
  itemKey,
  render,
  gap,
  reveal,
  revealKey,
}: {
  items: T[]
  itemKey({ item }: { item: T }): string
  render({ item }: { item: T }): ReactNode
  gap: number
  reveal?: string | null
  revealKey?: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const index = items.findIndex(item => itemKey({ item }) === reveal)
  useLayoutEffect(
    () => {
      element.current?.children[index]?.scrollIntoView({
        block: 'nearest',
        inline: 'start',
        behavior: 'instant',
      })
    },
    [
      index,
      reveal,
      revealKey,
    ],
  )

  return (
    <div
      ref={element}
      data-scroll-content
      className="relative flex h-full flex-none"
      style={{ gap }}
    >
      {items.map(item => <div key={itemKey({ item })} className="h-full w-max flex-none">{render({ item })}</div>)}
    </div>
  )
}
