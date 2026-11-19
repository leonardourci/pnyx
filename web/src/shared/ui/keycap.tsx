import type { ComponentProps } from 'react'

export function Keycap({
  as: Element = 'kbd',
  className = '',
  ...props
}: ComponentProps<'kbd'> & { as?: 'kbd' | 'span' }) {
  const classes = `inline-flex items-center border border-line border-b-2 rounded-compact bg-raised text-muted font-mono text-meta ${className}`

  return <Element {...props} className={classes} />
}
