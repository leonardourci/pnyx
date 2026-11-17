import type { ComponentProps } from 'react'

export function SettingsBox({
  className = '',
  ...props
}: ComponentProps<'section'>) {
  return <section {...props} className={`settings-box min-w-0 shrink-0 p-5 border border-line rounded-lg bg-surface max-[760px]:p-3.75 [&>h2]:font-brand [&>h2]:font-bold [&_p]:text-ui [&_p]:mt-1.25 [&_p]:mx-0 [&_p]:mb-3 [&>.switch-label]:flex [&>.switch-label]:mt-3 [&_.switch-label]:text-ui [&>.button.surface]:mt-4.5 [&_dl]:text-ui [&_dl]:text-muted [&_dt]:mt-3 [&_dd]:my-1 [&_dd]:mx-0 [&_dd]:text-ink ${className}`} />
}
