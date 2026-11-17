import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'

export function Panel({
  shown,
  connected,
  offline,
  upgrade,
  startUpgrade,
  page,
  navigate,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  offline: boolean
  upgrade?: UpgradeStatus
  startUpgrade(): void
  page: string
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  const settings = page === 'settings'

  return createPortal(
    <header className="topbar fixed inset-x-0 top-0 z-70 flex h-12.5 items-center gap-3 border-b border-line bg-background px-3.5 [&[hidden]]:hidden visible max-[760px]:gap-1.5 max-[760px]:px-2" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand flex shrink-0 items-center gap-2 text-pane font-bold text-gold max-[760px]:[&>span]:hidden"><Icon name="pnyx" size={ICON_SIZE.brand} /><span>pnyx</span>{offline && <span className="offline text-red font-sans text-meta font-normal tracking-normal" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {children}
      <nav className="ml-auto flex flex-none items-center gap-1.5" aria-label="Main pages">
        {oracle}
        <IconButton
          label={settings ? 'Close Settings' : 'Settings'}
          aria-pressed={settings}
          onClick={() => navigate({ page: settings ? 'hydra' : 'settings' })}
          icon={settings ? 'close' : 'settings'}
        />
      </nav>
    </header>,
    document.body,
  )
}
