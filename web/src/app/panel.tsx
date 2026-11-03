import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'

export function Panel({
  shown,
  connected,
  upgrade,
  startUpgrade,
  page,
  navigate,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  upgrade?: UpgradeStatus
  startUpgrade(): void
  page: string
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  const settings = page === 'settings'

  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-pressed={settings} onClick={() => navigate({ page: settings ? 'hydra' : 'settings' })}><Icon name="settings" />Settings</Button>
      </nav>
      {children}
    </aside>
  )
}
