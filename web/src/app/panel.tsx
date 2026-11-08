import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'
import { useKeyboard } from '#web-preferences/keyboard-registry.tsx'

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
  const { label: keys } = useKeyboard()
  const settingsKey = keys({ id: 'settings' })

  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{offline && <span className="offline" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-label="Settings" aria-pressed={settings} onClick={() => navigate({ page: settings ? 'hydra' : 'settings' })}><Icon name="settings" /><span>Settings</span>{settingsKey && <kbd>{settingsKey}</kbd>}</Button>
      </nav>
      {children}
    </aside>
  )
}
