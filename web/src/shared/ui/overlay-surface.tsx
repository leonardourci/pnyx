import type { ComponentProps } from 'react'

export function OverlaySurface({
  variant = 'dialog',
  className = '',
  ...props
}: ComponentProps<'dialog'> & { variant?: 'dialog' | 'oracle' }) {
  const layout = {
    dialog: 'dialog m-auto w-dialog max-h-dialog-height shadow-dialog',
    oracle: 'oracle-palette mx-auto mt-oracle-top mb-auto h-oracle-height w-oracle overflow-hidden shadow-oracle [&>.search-bar]:m-2.5 max-[760px]:mt-3 max-[760px]:h-oracle-mobile',
  }[variant]

  return <dialog {...props} className={`rounded-xl border border-line bg-surface p-0 text-ink open:flex open:flex-col backdrop:bg-shadow ${layout} ${className}`} />
}
