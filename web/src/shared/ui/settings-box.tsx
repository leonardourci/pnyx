import type { ComponentProps } from 'react'

export function SettingsBox({
  className = '',
  ...props
}: ComponentProps<'section'>) {
  return <section {...props} className={`settings-box min-w-0 shrink-0 rounded-lg border border-line bg-surface p-5 max-phone:p-3.75 [&_.switch-label]:text-ui [&_dd]:mx-0 [&_dd]:my-1 [&_dd]:text-ink [&_dl]:text-ui [&_dl]:text-muted [&_dt]:mt-3 [&_p]:mx-0 [&_p]:mt-1.25 [&_p]:mb-3 [&_p]:text-ui [&>.button.surface]:mt-4.5 [&>.switch-label]:mt-3 [&>.switch-label]:flex [&>h2]:font-brand [&>h2]:font-bold ${className}`} />
}
