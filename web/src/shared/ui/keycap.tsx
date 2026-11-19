import type { ComponentProps } from 'react'

export function Keycap({
  as: Element = 'kbd',
  className = '',
  ...props
}: ComponentProps<'kbd'> & { as?: 'kbd' | 'span' }) {
  return <Element {...props} className={`inline-flex items-center border border-line border-b-2 rounded-compact bg-raised text-muted font-mono text-meta whitespace-nowrap ${className}`} />
}
