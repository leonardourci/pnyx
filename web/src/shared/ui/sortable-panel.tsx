import { motion, type HTMLMotionProps } from 'motion/react'
import type { RefCallback } from 'react'

export function SortablePanel({
  as = 'div',
  surface = 'card',
  lifted = false,
  className = '',
  ...props
}: Omit<HTMLMotionProps<'section'>, 'ref'> & {
  as?: 'div' | 'section'
  surface?: 'card' | 'column'
  lifted?: boolean
  ref?: RefCallback<HTMLElement>
}) {
  const fill = surface === 'card' ? 'data-[drag-slot=true]:rounded-card data-[drag-slot=true]:bg-gold-wash' : ''
  const classes = `data-[drag-slot=true]:outline data-[drag-slot=true]:outline-gold-line data-[drag-slot=true]:outline-dashed [&[data-drag-slot=true]>*]:invisible ${fill} ${className}`

  if (as === 'section') {
    return (
      <motion.section
        layout="position"
        {...props}
        data-drag-slot={lifted}
        className={classes}
      />
    )
  }

  return (
    <motion.div
      layout="position"
      {...props}
      data-drag-slot={lifted}
      className={classes}
    />
  )
}
