import { Icon } from '#web-shared/ui/icon.tsx'
import { useId, useRef, useState } from 'react'
import type { Card } from '#tasks/model.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'

export function ReminderLabel({ card }: { card: Card }) {
  if (!card.reminder || card.reminder.dueAt) {
    return null
  }

  const date = new Date(card.reminder.at)
  const when = new Intl.DateTimeFormat(
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ).format(date)

  return <span className="reminder-label" title={date.toISOString()}><Icon name="reminder" size={14} />reminds you {when}</span>
}

export interface ReminderDraft {
  value: string
  attempt: string
  error: string
}

export function ReminderEditor({
  card,
  command,
  connected,
  close,
  submitted,
  recover,
  draft,
}: {
  card: Card
  command: Command
  connected: boolean
  close(): void
  submitted(): void
  recover({ draft }: { draft: ReminderDraft }): void
  draft?: ReminderDraft
}) {
  const id = useId()
  const [
    when,
    setWhen,
  ] = useState(draft?.value ?? (card.reminder?.dueAt ? '' : card.reminder?.at ?? ''))
  const attempt = useRef(draft?.attempt ?? crypto.randomUUID())
  const sending = useRef(false)

  const save = ({ value }: { value: string }) => {
    if (sending.current) {
      return
    }

    sending.current = true
    const saving = command({
      name: 'task',
      args: [
        'remind',
        card.id,
        value,
        '--if-revision',
        String(card.revision),
        '--event-id',
        attempt.current,
      ],
    })
    submitted()
    void saving.catch((error: Error) => {
      if (error instanceof CommandFailure && error.outcome === 'unknown') {
        return
      }

      recover({
        draft: {
          value: when,
          attempt: attempt.current,
          error: error.message,
        },
      })
    })
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
        disabled={!connected}
        onChange={event => setWhen(event.target.value)}
      />
      <small className="muted">“Tomorrow” uses the laptop’s time. You can also enter an ISO timestamp with a timezone.</small>
      {draft?.error && <p role="alert">{draft.error}</p>}
      <div className="row">
        <Button type="submit" disabled={!connected || !when.trim()}>Set reminder</Button>
        {card.reminder && <Button disabled={!connected} onClick={() => void save({ value: 'clear' })}>Clear reminder</Button>}
        <Button onClick={close}>Cancel</Button>
      </div>
    </form>
  )
}
