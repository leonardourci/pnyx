import { useId, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function ReminderLabel({ card }: { card: Card }) {
  if (!card.reminder || card.reminder.dueAt) {
    return null
  }

  const date = new Date(card.reminder.at)
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)

  return <span className="reminder-label" title={date.toISOString()}>⏰ reminds you {when}</span>
}

export function ReminderEditor({ card, command, connected, close }: {
  card: Card
  command: Command
  connected: boolean
  close(): void
}) {
  const id = useId()
  const [when, setWhen] = useState(card.reminder?.dueAt ? '' : card.reminder?.at ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')

  const save = async ({ value }: { value: string }) => {
    setBusy(true); setError('')

    try {
      await command({ name: 'task', args: ['remind', card.id, value, '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] })
      close()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="reminder-editor"
      aria-label={`Reminder for ${card.title}`}
      onSubmit={event => {
        event.preventDefault(); void save({ value: when })
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation(); close()
        }
      }}
    >
      <label htmlFor={id}>Remind me</label>
      <Input
        id={id}
        aria-label="Reminder time"
        autoFocus
        placeholder="tomorrow 9:00 or in 2 hours"
        value={when}
        disabled={!connected || busy}
        onChange={event => setWhen(event.target.value)}
      />
      <small className="muted">“Tomorrow” uses the laptop’s time. You can also enter an ISO timestamp with a timezone.</small>
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <Button type="submit" disabled={!connected || busy || !when.trim()}>Set reminder</Button>
        {card.reminder && <Button disabled={!connected || busy} onClick={() => void save({ value: 'clear' })}>Clear reminder</Button>}
        <Button disabled={busy} onClick={close}>Cancel</Button>
      </div>
    </form>
  )
}
