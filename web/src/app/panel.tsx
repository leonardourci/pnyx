import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

  return createPortal(
    <header className="topbar fixed inset-x-0 top-0 z-70 flex h-12.5 items-center gap-3 border-b border-line bg-background px-3.5 [&[hidden]]:hidden visible max-[760px]:gap-1.5 max-[760px]:px-2" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand flex shrink-0 items-center gap-2 text-pane font-bold text-gold max-[760px]:[&>span]:hidden"><Icon name="pnyx" size={24} /><span>pnyx</span>{offline && <span className="offline" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {children}
      <nav className="ml-auto flex flex-none items-center gap-1.5 [&>.button>span]:hidden [&>.button>kbd]:hidden [&>.oracle-trigger]:m-0 [&>.oracle-trigger]:w-8 [&>.oracle-trigger]:flex-none [&>.oracle-trigger]:p-1.5" aria-label="Main pages">
        {oracle}
        <Button aria-label={settings ? 'Close Settings' : 'Settings'} aria-pressed={settings} onClick={() => navigate({ page: settings ? 'hydra' : 'settings' })}><Icon name={settings ? 'close' : 'settings'} /><span>Settings</span>{settingsKey && <kbd>{settingsKey}</kbd>}</Button>
      </nav>
    </header>,
    document.body,
  )
}
