import { Icon } from '../components/ui/icon.tsx'
import type { ReactNode } from 'react'
import { Button } from '../components/ui/controls.tsx'

export function Panel({
  shown,
  connected,
  page,
  navigate,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  page: string
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}</div>
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-pressed={page === 'settings'} onClick={() => navigate({ page: 'settings' })}><Icon name="settings" />Settings</Button>
      </nav>
      {children}
    </aside>
  )
}
