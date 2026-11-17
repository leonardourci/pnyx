import { motion } from 'motion/react'
import type { ComponentProps } from 'react'
import { Button } from './controls.tsx'
import { useSortItem, type SortItem } from './sortable.tsx'

const AnimatedButton = motion.create(Button)

export function SortableButton({
  item,
  disabledSort = false,
  className = '',
  ...props
}: ComponentProps<typeof AnimatedButton> & {
  item: SortItem
  disabledSort?: boolean
}) {
  const sort = useSortItem({
    item,
    disabled: disabledSort,
  })

  return (
    <AnimatedButton
      layout="position"
      {...props}
      className={`${className} ${sort.isDragging ? 'opacity-0' : ''}`}
      ref={sort.setNodeRef}
      {...sort.attributes}
      {...sort.listeners}
      data-sort-key={sort.key}
      data-sort-id={item.id}
      data-sort-kind={item.kind}
      data-sort-scope={item.scope}
    />
  )
}
