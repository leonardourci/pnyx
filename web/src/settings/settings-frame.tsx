import type { ComponentProps } from 'react'

export function SettingsFrame({
  children,
  ...props
}: ComponentProps<'section'>) {
  return (
    <section {...props} className="settings-page min-h-0 flex-1 overflow-y-auto px-[max(--spacing(5),calc((100%-var(--spacing-settings-content))/2))] pb-30 scroll-pt-[calc(var(--settings-search-height,120px)+8px)] [--settings-column-gap:calc(var(--spacing)*3.5)] [--agent-control-h:calc(var(--control-h)+var(--text-meta))]" aria-label="Settings">
      <header className="settings-head pt-7 pb-1.5 text-center [&>h1]:m-0 [&>h1]:font-brand [&>h1]:text-pane [&>h1]:font-bold [&>p]:mt-0.5 [&>p]:text-ui [&>p]:text-muted"><h1 data-settings-heading tabIndex={-1}>Settings</h1></header>
      {children}
    </section>
  )
}
