import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { createPortal } from 'react-dom'
import type { TitanSummary } from '#app/server-titans.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { BottomSheet } from '#web-shared/ui/bottom-sheet.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { DisclosureChevron } from '#web-shared/ui/disclosure-chevron.tsx'
import { WaitingCount } from '#web-shared/ui/waiting-count.tsx'
import { TitanLabel } from '#web-titan/titan-title.tsx'
import { UpgradeHint } from '#web-upgrade/upgrade-hint.tsx'

// How close to the top edge the pointer must come to bring a hidden wide nav back for a look.
const TOP_EDGE = 4
const BAR = 'topbar visible fixed inset-x-0 top-0 z-70 flex h-topbar-height items-center gap-3 border-b border-line bg-background px-3.5 pt-safe-top max-phone:gap-1.5 max-phone:px-2'

function useTopEdgePeek({ enabled }: { enabled: boolean }) {
  const [
    peeking,
    setPeeking,
  ] = useState(false)
  useEffect(
    () => {
      if (!enabled) {
        setPeeking(false)

        return
      }

      const move = (event: PointerEvent) => {
        if (event.pointerType !== 'mouse') {
          return
        }

        // The bar's own menus are inside it, so moving into one keeps the bar shown.
        const overBar = event.target instanceof Element && !!event.target.closest('.topbar')
        setPeeking(event.clientY <= TOP_EDGE || overBar)
      }

      window.addEventListener(
        'pointermove',
        move,
        { passive: true },
      )

      return () => window.removeEventListener(
        'pointermove',
        move,
      )
    },
    [enabled],
  )

  return peeking
}

function Brand({
  connected,
  offline,
  upgrade,
  startUpgrade,
}: {
  connected: boolean
  offline: boolean
  upgrade?: UpgradeStatus
  startUpgrade(): void
}) {
  return <div className="brand flex shrink-0 items-center gap-2 text-pane font-bold text-gold max-phone:[&>span]:hidden"><Icon name="othrys" size={ICON_SIZE.brand} /><span>othrys</span>{offline && <span className="offline font-sans text-meta font-normal tracking-normal text-red" role="status">offline</span>}{connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}</div>
}

export function Panel({
  shown,
  connected,
  offline,
  upgrade,
  startUpgrade,
  page,
  navigate,
  oracle,
  phone,
  hidden,
  reveal,
  titan,
  waiting,
  sheet,
  openWaiting,
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
  phone: boolean
  // The nav is hidden for the current layout: a small Titan chip on wide screens, a short header on the phone.
  hidden: boolean
  reveal(): void
  titan?: TitanSummary
  waiting: number
  sheet({ close }: { close(): void }): ReactNode
  openWaiting(): void
  children: ReactNode
}) {
  const peeking = useTopEdgePeek({ enabled: shown && hidden && !phone })
  const [
    sheetOpen,
    setSheetOpen,
  ] = useState(false)
  const compact = hidden && !peeking
  useLayoutEffect(
    () => {
      if (!shown) {
        return
      }

      document.documentElement.toggleAttribute(
        'data-nav-hidden',
        hidden,
      )
    },
    [
      shown,
      hidden,
    ],
  )

  if (!shown) {
    return null
  }

  const settings = page === 'settings'
  const titanLabel = titan && (
    <TitanLabel name={titan.name} icon={titan.icon} size={ICON_SIZE.control} />
  )
  const mainPages = (
    <nav className="ml-auto flex flex-none items-center gap-1.5" aria-label="Main pages">
      {oracle}
      {!(compact && phone) && (
        <IconButton
          label={settings ? 'Close Settings' : 'Settings'}
          aria-pressed={settings}
          onClick={() => navigate({ page: settings ? 'titan' : 'settings' })}
          icon={settings ? 'close' : 'settings'}
        />
      )}
      {compact && phone && (
        <Button
          className="phone-waiting px-1.5"
          aria-label="Waiting on you"
          disabled={!waiting}
          onClick={openWaiting}
        >
          <WaitingCount count={waiting} />
        </Button>
      )}
    </nav>
  )

  if (compact && !phone) {
    return createPortal(
      <header className="topbar-chip fixed top-0 left-3 z-70 flex h-topbar-height items-center pt-safe-top" aria-label="Othrys navigation">
        <Button
          variant="surface"
          className="nav-chip gap-1.75 rounded-full border-gold-line bg-gold-wash px-2.5 py-1"
          aria-label="Show the nav"
          onClick={reveal}
        >
          {titanLabel}
          <WaitingCount count={waiting} />
          <DisclosureChevron expanded={false} />
        </Button>
      </header>,
      document.body,
    )
  }

  if (compact) {
    return createPortal(
      <>
        <header className={`${BAR} phone-header`} aria-label="Othrys navigation">
          {settings && (
            <IconButton label="Back" icon="chevron_left" onClick={() => navigate({ page: 'titan' })} />
          )}
          <Button
            className="phone-titan min-w-0 gap-1.5 px-1.5 font-semibold"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            {titanLabel}
            <DisclosureChevron expanded={sheetOpen} />
          </Button>
          {offline && <span className="offline text-meta text-red" role="status">offline</span>}
          {connected && <UpgradeHint status={upgrade} upgrade={startUpgrade} />}
          {mainPages}
        </header>
        {sheetOpen && (
          <BottomSheet label="Navigation" close={() => setSheetOpen(false)}>
            {sheet({ close: () => setSheetOpen(false) })}
          </BottomSheet>
        )}
      </>,
      document.body,
    )
  }

  return createPortal(
    <motion.header
      layoutScroll
      className={BAR}
      aria-label="Othrys navigation"
    >
      <Brand
        connected={connected}
        offline={offline}
        upgrade={upgrade}
        startUpgrade={startUpgrade}
      />
      {children}
      {mainPages}
    </motion.header>,
    document.body,
  )
}
