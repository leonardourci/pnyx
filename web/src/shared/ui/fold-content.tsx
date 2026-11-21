import type { ComponentProps } from 'react'

export function FoldContent({
  open,
  as: Surface = 'div',
  className = '',
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'hidden'> & {
  open: boolean
  as?: 'div' | 'main'
}) {
  return (
    <Surface
      {...props}
      data-fold-open={open}
      hidden={!open}
      className={`[&[hidden]]:hidden ${className}`}
    >{open ? children : null}
    </Surface>
  )
}
