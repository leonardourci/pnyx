import type { HydraState } from '../../../src/core/model.ts'
import { waitingReminders } from '../../../src/reminders/state.ts'
import { useState, type ReactNode } from 'react'
import { Button } from '../components/ui/controls.tsx'

export function Panel({ shown, connected, page, navigate, state, openTask, oracle, children }: {
  shown: boolean
  connected: boolean
  page: string
  state: HydraState
  openTask({ id }: { id: string }): void
  navigate({ page }: { page: string }): void
  oracle: ReactNode
  children: ReactNode
}) {
  const [reminders, setReminders] = useState(false)
  const waiting = waitingReminders({ state })

  return (
    <aside className="left-panel" aria-label="Pnyx navigation" hidden={!shown}>
      <div className="brand"><span>pnyx</span>{!connected && <span className="offline" role="status">offline</span>}</div>
      {oracle}
      <nav aria-label="Main pages">
        <Button aria-expanded={reminders} aria-controls="panel-reminders" onClick={() => setReminders(open => !open)}>Reminders <span className="panel-count">{waiting.length}</span></Button>
        {reminders && (
          <div id="panel-reminders">
            {waiting.length ? (
              <ul className="panel-reminders">
                {waiting.map(reminder => (
                  <li key={reminder.task}>
                    <Button onClick={() => openTask({ id: reminder.task })}>
                      <span>{reminder.title}</span>
                      <time dateTime={reminder.at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reminder.at))}</time>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : <p className="panel-empty">No waiting reminders.</p>}
          </div>
        )}
        {[['history', 'History'], ['settings', 'Settings']].map(([id, label]) => <Button key={id} aria-pressed={page === id} onClick={() => navigate({ page: id })}>{label}</Button>)}
      </nav>
      {children}
    </aside>
  )
}
