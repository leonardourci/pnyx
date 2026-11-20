import type { ComponentProps } from 'react'

export function OverlaySurface({
  variant = 'dialog',
  className = '',
  ...props
}: ComponentProps<'dialog'> & { variant?: 'dialog' | 'oracle' }) {
  const layout = {
    dialog: 'dialog m-auto max-h-dialog-height w-dialog shadow-dialog',
    oracle: 'oracle-palette mx-auto mt-oracle-top mb-auto h-oracle-height w-oracle overflow-hidden shadow-oracle [&>.search-bar]:m-2.5',
  }[variant]

  return <dialog {...props} className={`rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-shadow open:flex open:flex-col ${layout} ${className}`} />
}
