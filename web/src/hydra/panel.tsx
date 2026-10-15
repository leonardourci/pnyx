import { useState, type ReactNode } from 'react'
import { Button } from '../components/ui/controls.tsx'

export function Panel({ shown, connected, page, navigate, oracle, children }: {
  shown: boolean
  connected: boolean
  page: string
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  const [reminders, setReminders] = useState(false)

  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}</div>
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-expanded={reminders} aria-controls="panel-reminders" onClick={() => setReminders(open => !open)}>Reminders <span className="panel-count">0</span></Button>
        {reminders && <p id="panel-reminders" className="panel-empty">No waiting reminders.</p>}
        {[['history', 'History'], ['settings', 'Settings']].map(([id, label]) => <Button key={id} aria-pressed={page === id} onClick={() => navigate({ page: id })}>{label}</Button>)}
      </nav>
      {children}
    </aside>
  )
}
