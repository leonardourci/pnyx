import { useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

const DELAYS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours (default)' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
  { hours: 0, label: 'Keep visible' },
]

export function HideAfter({ card, command, connected, notify }: {
  card: Card
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const [open, setOpen] = useState(false)
  const selected = card.keepDone ? 0 : card.doneAfterHours

  return (
    <>
      <Button data-menu-keep aria-expanded={open} onClick={() => setOpen(value => !value)}>
        Hide after…
      </Button>
      {open && (
        <div className="hide-after" role="group" aria-label="Hide after">
          <span>Time in Done</span>
          {DELAYS.map(({ hours, label }) => (
            <Button
              key={hours}
              aria-pressed={selected === hours}
              disabled={!connected}
              onClick={() => void command({ name: 'task', args: ['hide-after', card.id, String(hours), '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] })
                .catch(e => notify({ text: e.message }))}
            >{label}
            </Button>
          ))}
          <Button
            aria-pressed={selected === undefined}
            disabled={!connected}
            onClick={() => void command({ name: 'task', args: ['hide-after', card.id, 'default', '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] })
              .catch(e => notify({ text: e.message }))}
          >Use Hydra setting
          </Button>
        </div>
      )}
    </>
  )
}
