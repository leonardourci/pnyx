import type { ComponentProps, ReactNode } from 'react'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export function SettingsFrame({
  children,
  ...props
}: ComponentProps<'section'>) {
  return (
    <section {...props} className="settings-page min-h-0 flex-1 scroll-pt-settings-scroll overflow-y-auto px-settings pb-30 text-ui leading-normal agent-controls settings-columns" aria-label="Settings">
      <header className="settings-head pt-7 pb-1.5 text-center [&>h1]:m-0 [&>h1]:font-brand [&>h1]:text-pane [&>h1]:font-bold [&>p]:mt-0.5 [&>p]:text-ui [&>p]:text-muted"><h1 data-settings-heading tabIndex={-1}>Settings</h1></header>
      {children}
    </section>
  )
}

export function SettingsSearch({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="settings-search sticky top-0 z-20 bg-settings-fade pt-3.5 pb-2.5 [&_.search-bar]:mx-auto [&_.search-bar]:my-0 [&_.search-bar]:max-w-settings-search [&_.search-bar]:px-3 [&_.search-bar]:py-2 [&_.search-bar]:shadow-settings-search [&_.search-bar-eye]:text-muted [&_.search-bar:focus-within]:shadow-settings-focus" />
}

export function SettingsSection({
  id,
  label,
  icon,
  note,
  children,
}: {
  id: string
  label: string
  icon: string
  note?: string
  children: ReactNode
}) {
  const heading = `settings-${id}-title`

  return (
    <section id={`settings-${id}`} aria-labelledby={heading} className="settings-section mt-7 scroll-mt-2 [&>h2]:mx-0 [&>h2]:mt-0 [&>h2]:mb-0.5 [&>h2]:flex [&>h2]:items-center [&>h2]:gap-2.25 [&>h2]:font-brand [&>h2]:text-settings-section [&>h2]:font-bold [&>h2+.settings-rows]:mt-2.5">
      <h2 id={heading}>
        <span className="settings-section-icon grid size-7 place-items-center rounded-control border border-gold-line bg-gold-wash text-gold"><Icon name={icon} size={ICON_SIZE.control} /></span>{label}
      </h2>
      {note !== undefined && <p className="settings-section-note mx-0 mt-0.5 mb-2.5 text-ui text-muted">{note}</p>}
      {children}
    </section>
  )
}
