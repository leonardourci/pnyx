import type { ComponentProps } from 'react'

export function Keycap({
  as: Element = 'kbd',
  className = '',
  ...props
}: ComponentProps<'kbd'> & { as?: 'kbd' | 'span' }) {
  const classes = `inline-flex items-center rounded-compact border border-b-2 border-line bg-raised font-mono text-meta text-muted ${className}`

  return <Element {...props} className={classes} />
}
