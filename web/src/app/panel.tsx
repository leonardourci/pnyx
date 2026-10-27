import { Icon } from '../shared/ui/icon.tsx'
import type { ReactNode } from 'react'

export function Panel({
  shown,
  connected,
  oracle,
  children,
}: {
  shown: boolean
  connected: boolean
  oracle: ReactNode
  children: ReactNode
}) {
  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><Icon name="pnyx" size={24} /><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}</div>
      {oracle}
      {children}
    </aside>
  )
}
