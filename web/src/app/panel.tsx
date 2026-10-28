import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'

export function Panel({
  shown,
  connected,
  upgrade,
  startUpgrade,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  upgrade?: UpgradeStatus
  startUpgrade(): void
  oracle: ReactNode
  children: ReactNode
}) {
  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {oracle}
      {children}
    </aside>
  )
}
