import { motion } from 'motion/react'
import type { ComponentProps } from 'react'
import { Chip } from './chip.tsx'
import { useSortItem, type SortItem } from './sortable.tsx'

const AnimatedChip = motion.create(Chip)

export function SortableChip({
  item,
  disabledSort = false,
  className = '',
  ...props
}: ComponentProps<typeof AnimatedChip> & {
  item: SortItem
  disabledSort?: boolean
}) {
  const sort = useSortItem({
    item,
    disabled: disabledSort,
  })

  return (
    <AnimatedChip
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
