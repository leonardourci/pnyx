import { useEffect, useRef, useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import { boardConfig } from '../../../src/core/hydra.ts'
import { Button, Textarea, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

// The board's Hydra chat, docked beside the columns: what was sent to Hydra, newest
// at the bottom, and the composer under it. Enter sends, Shift+Enter adds a line.
export function HydraChat({ state, command, connected, openTask, notify }: {
  state: BoardState
  command: Command
  connected: boolean
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
}) {
  const [draft, setDraft] = useState('')
  const [busy, run] = useBusy()
  const end = useRef<HTMLDivElement>(null)
  const hydra = boardConfig({ state }).hydra
  const messages = (state.hydraMessages ?? []).filter(m => m.hydra === hydra.id)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = () => {
    if (!draft.trim()) {
      return
    }

    const submitted = draft
    run({
      save: () => command({ name: 'hydra', args: ['send', `--text=${submitted}`, '--event-id', crypto.randomUUID()] })
        .then(() => setDraft(current => current === submitted ? '' : current))
        .catch(e => notify({ text: e.message })),
    })
  }

  return (
    <aside className="hydra-chat" aria-label="Hydra chat">
      <header className="hydra-head">
        <strong>{hydra.name}</strong>
        <span className="muted small">{messages.length ? `${messages.length} messages` : 'orchestrator'}</span>
      </header>
      <div className="hydra-messages">
        {messages.length ? messages.map(m => (
          <article key={m.id} className="hydra-message">
            {m.action === 'worker' && <span className="eyebrow">Create a worker</span>}
            <p>{m.text}</p>
            {m.task && (
              <Button onClick={() => openTask({ id: m.task! })}>
                {state.cards[m.task]?.title ?? m.task}
              </Button>
            )}
            <time>{new Date(m.at).toLocaleString()}</time>
          </article>
        )) : <p className="empty">No messages yet. Write to Hydra here, or use Send to Hydra on a task.</p>}
        <div ref={end} />
      </div>
      <form
        className="hydra-composer"
        aria-busy={busy}
        onSubmit={e => {
          e.preventDefault(); send()
        }}
      >
        <Textarea
          aria-label="Message Hydra"
          placeholder="Message Hydra…"
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault(); send()
            }
          }}
          disabled={!connected}
        />
        <Button type="submit" variant="primary" disabled={!connected || busy || !draft.trim()}>Send</Button>
      </form>
    </aside>
  )
}
