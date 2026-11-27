import type { ComponentProps } from 'react'

export function OverlaySurface({
  variant = 'dialog',
  className = '',
  ...props
}: ComponentProps<'dialog'> & { variant?: 'dialog' | 'oracle' | 'sheet' }) {
  const layout = {
    dialog: 'dialog m-auto max-h-dialog-height w-dialog shadow-dialog',
    sheet: 'sheet mx-0 mt-auto mb-0 max-h-sheet-height w-full max-w-none rounded-b-none pb-safe-bottom shadow-dialog',
    oracle: 'oracle-palette mx-auto mt-oracle-top mb-auto h-oracle-height w-oracle overflow-hidden shadow-oracle [&>.search-bar]:m-2.5',
  }[variant]

  return <dialog {...props} className={`rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-shadow open:flex open:flex-col ${layout} ${className}`} />
}
