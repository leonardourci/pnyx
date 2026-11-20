import { useLayoutEffect, useState } from 'react'
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { motionDuration, MOTION_EASING } from '#web-shared/motion.ts'

export function FoldContent({
  open,
  axis = 'height',
  as = 'div',
  className = '',
  layout = 'position',
  children,
  ...props
}: Omit<HTMLMotionProps<'div'>, 'hidden'> & {
  open: boolean
  axis?: 'height' | 'width' | 'none'
  as?: 'div' | 'main'
}) {
  const [
    closed,
    setClosed,
  ] = useState(!open)
  const reducedMotion = useReducedMotion()
  useLayoutEffect(
    () => {
      if (open) {
        setClosed(false)
      }
    },
    [open],
  )
  const Surface = as === 'main' ? motion.main : motion.div
  const dimensions = axis === 'none' ? {} : { [axis]: open ? 'auto' : 0 }

  return (
    <Surface
      {...props}
      data-fold-open={open}
      inert={!open}
      aria-hidden={!open}
      hidden={closed && !open}
      layout={layout}
      initial={false}
      animate={{
        ...dimensions,
        opacity: open ? 1 : 0,
      }}
      transition={{
        duration: motionDuration({ reducedMotion: !!reducedMotion }) / 1000,
        ease: MOTION_EASING,
      }}
      onAnimationComplete={() => setClosed(!open)}
      className={`overflow-hidden [&[hidden]]:hidden ${className}`}
    >{open || !closed ? children : null}
    </Surface>
  )
}
