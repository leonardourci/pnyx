import type { ComponentProps } from 'react'

export function ReceiptStatus({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return <span {...props} className={`receipt mt-1 block text-right text-meta text-green ${className}`} />
}
