import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
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
  if (!shown) {
    return null
  }

  const settings = page === 'settings'

  return createPortal(
    <motion.header layoutScroll className="topbar visible fixed inset-x-0 top-0 z-70 flex h-topbar-height items-center gap-3 border-b border-line bg-background px-3.5 max-phone:gap-1.5 max-phone:px-2" aria-label="Othrys navigation">
      <div className="brand flex shrink-0 items-center gap-2 text-pane font-bold text-gold max-phone:[&>span]:hidden"><Icon name="othrys" size={ICON_SIZE.brand} /><span>othrys</span>{offline && <span className="offline font-sans text-meta font-normal tracking-normal text-red" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
      {children}
      <nav className="ml-auto flex flex-none items-center gap-1.5" aria-label="Main pages">
        {oracle}
        <IconButton
          label={settings ? 'Close Settings' : 'Settings'}
          aria-pressed={settings}
          onClick={() => navigate({ page: settings ? 'titan' : 'settings' })}
          icon={settings ? 'close' : 'settings'}
        />
      </nav>
    </motion.header>,
    document.body,
  )
}
