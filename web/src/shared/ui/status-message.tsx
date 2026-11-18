import type { ComponentProps } from 'react'

export function StatusMessage({
  pending = false,
  className = '',
  ...props
}: ComponentProps<'p'> & { pending?: boolean }) {
  const position = pending ? 'pending-status fixed right-4 bottom-4 max-w-status pointer-events-none' : 'loading-status absolute top-2 left-1/2'

  return <p {...props} className={`z-70 py-2 px-4 rounded-lg bg-surface text-muted shadow-status ${position} ${className}`} />
}

export function StatusNotice({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="notice fixed bottom-4 right-4 z-80 flex items-center gap-3 max-w-status py-3 px-4 rounded-lg bg-surface text-ink shadow-notice" />
}

export function ErrorBanner({ ...props }: ComponentProps<'p'>) {
  return <p {...props} className="error-banner py-2.25 px-3 text-red border border-line rounded-md text-ui" />
}
