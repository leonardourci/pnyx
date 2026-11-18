import type { ComponentProps } from 'react'

export function FloatingPanel({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`fixed inset-auto m-0 overflow-auto border border-line bg-raised text-ink shadow-menu ${className}`} />
}
