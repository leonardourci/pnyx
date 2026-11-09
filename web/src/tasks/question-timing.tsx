import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Ask, Card } from '#tasks/model.ts'
import { reminderTime } from '#tasks/time.ts'
import type { Command } from '#web-app/connection.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'

export function QuestionTiming({
  card,
  ask,
  command,
  notify,
  disabled = false,
}: {
  card: Card
  ask: Ask
  command: Command
  notify({ text }: { text: string }): void
  disabled?: boolean
}) {
  const [
    editing,
    setEditing,
  ] = useState(false)
  const [
    when,
    setWhen,
  ] = useState('')
  const [
    error,
    setError,
  ] = useState('')
  const generation = useRef(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useLayoutEffect(
    () => {
      if (!editing && restoreFocus.current) {
        restoreFocus.current = false
        trigger.current?.focus()
      }
    },
    [editing],
  )
  const id = useId()
  const date = new Date(ask.deferredUntil ?? '')
  const knownDate = Number.isFinite(date.getTime())
  const label = knownDate ? date.toLocaleString(
    [],
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ) : ask.deferredUntil

  const save = async ({ value }: { value: string }) => {
    const attempt = ++generation.current

    try {
      const until = value === 'clear' ? value : reminderTime({
        when: value,
        now: new Date().toISOString(),
      })
      const saving = command({
        name: 'task',
        args: [
          'defer-question',
          card.id,
          ask.id,
          '--until',
          until,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      restoreFocus.current = true
      setEditing(false)
      setError('')
      await saving
    } catch (failure) {
      if (attempt !== generation.current) {
        return
      }

      if (failure instanceof CommandFailure && failure.outcome === 'unknown') {
        notify({ text: 'Checking whether the question date was saved.' })

        return
      }

      setWhen(value === 'clear' ? '' : value)
      setEditing(true)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  if (editing) {
    return (
      <form
        className="reminder-editor"
        aria-label="Question date"
        onSubmit={async event => {
          event.preventDefault(); await save({ value: when })
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            generation.current++
            restoreFocus.current = true
            setEditing(false)
          }
        }}
      >
        <label htmlFor={id}>Later until</label>
        <Input
          id={id}
          autoFocus
          aria-label="Question return date"
          value={when}
          placeholder="tomorrow 9:00 or in 2 hours"
          onChange={event => setWhen(event.target.value)}
        />
        <small className="muted">Times use the laptop’s timezone. The question stays unanswered.</small>
        {error && <p role="alert">{error}</p>}
        <div className="row">
          <Button type="submit" disabled={disabled || !when.trim()}>Set date</Button>
          <Button
            onClick={() => {
              generation.current++; restoreFocus.current = true; setEditing(false)
            }}
          >Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="pending-decision-actions">
      {ask.deferredUntil && <span className="muted small">Later until {label}</span>}
      <Button
        ref={trigger}
        disabled={disabled}
        onClick={() => {
          generation.current++; setWhen(ask.deferredUntil ?? ''); setError(''); setEditing(true)
        }}
      >
        {ask.deferredUntil ? 'Change date' : 'Later'}
      </Button>
      {ask.deferredUntil && (
        <Button
          disabled={disabled}
          onClick={async () => {
            await save({ value: 'clear' })
          }}
        >Answer now
        </Button>
      )}
    </div>
  )
}
