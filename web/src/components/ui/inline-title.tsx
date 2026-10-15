import { useEffect, useState } from 'react'
import { Button, Input } from './controls.tsx'

export function InlineTitle({ value, label, save, doubleClick = false, startEditing = false }: {
  value: string
  label: string
  save({ title }: { title: string }): Promise<unknown>
  doubleClick?: boolean
  startEditing?: boolean
}) {
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (startEditing) {
      setEditing(true)
    }
  }, [startEditing])

  const submit = async ({ title }: { title: string }) => {
    if (busy || !title) {
      return
    }

    setBusy(true)

    try {
      await save({ title })
      setEditing(false)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return editing ? (
    <form
      onSubmit={e => {
        e.preventDefault(); void submit({ title: draft.trim() })
      }}
    >
      <Input
        autoFocus
        aria-label={label}
        value={draft}
        maxLength={100}
        disabled={busy}
        onFocus={e => e.currentTarget.select()}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault(); e.stopPropagation(); setDraft(value); setEditing(false)
          }
        }}
      />
      <Button type="submit" disabled={busy || !draft.trim()}>Save title</Button>
      <Button
        onClick={() => {
          setDraft(value); setEditing(false)
        }}
      >Cancel
      </Button>
      {error && <span role="alert">{error}</span>}
    </form>
  ) : (
    <Button
      className="inline-title"
      aria-label={label}
      onClick={doubleClick ? undefined : () => setEditing(true)}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={e => {
        if (doubleClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault(); setEditing(true)
        }
      }}
    >
      {value}
    </Button>
  )
}
