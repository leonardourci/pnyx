import type { ComponentProps } from 'react'

export function ReceiptStatus({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return <span {...props} className={`receipt block mt-1 text-right text-meta text-green ${className}`} />
}
