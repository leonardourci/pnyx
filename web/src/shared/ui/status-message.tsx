import type { ComponentProps } from 'react'

export function StatusMessage({
  pending = false,
  className = '',
  ...props
}: ComponentProps<'p'> & { pending?: boolean }) {
  const position = pending ? 'pending-status pointer-events-none fixed right-4 bottom-4 max-w-status' : 'loading-status absolute top-2 left-1/2'

  return <p {...props} className={`z-70 rounded-lg bg-surface px-4 py-2 text-muted shadow-status ${position} ${className}`} />
}

export function StatusNotice({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="notice fixed right-4 bottom-4 z-80 flex max-w-status items-center gap-3 rounded-lg bg-surface px-4 py-3 text-ink shadow-notice" />
}

export function ErrorBanner({ ...props }: ComponentProps<'p'>) {
  return <p {...props} className="error-banner rounded-md border border-line px-3 py-2.25 text-ui text-red" />
}
