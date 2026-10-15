import { useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import { boardConfig } from '../../../src/core/hydra.ts'
import { Button, Input, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function HydraChat({ state, command, connected, openTask, notify }: {
  state: BoardState
  command: Command
  connected: boolean
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, run] = useBusy()
  const hydra = boardConfig({ state }).hydra
  const messages = (state.hydraMessages ?? []).filter(m => m.hydra === hydra.id)

  return (
    <section className="hydra-chat" aria-label="Hydra chat">
      <Button onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
        Hydra · {hydra.id} · {messages.length} messages
      </Button>
      {expanded && (
        <div className="hydra-messages">
          <p className="muted small">Task requests stay here for Hydra to read.</p>
          {messages.length ? messages.map(m => (
            <article key={m.id} className="message">
              <span className="eyebrow">{m.action === 'worker' ? 'Create a worker' : 'Send to Hydra'}</span>
              <p>{m.text}</p>
              {m.task && (
                <Button onClick={() => openTask({ id: m.task! })}>
                  {state.cards[m.task]?.title ?? m.task}
                </Button>
              )}
              <time>{new Date(m.at).toLocaleString()}</time>
            </article>
          )) : <p>No messages yet. Write to Hydra here, or use Send to Hydra on a task.</p>}
          <form
            aria-busy={busy}
            onSubmit={e => {
              e.preventDefault()

              if (!draft.trim()) {
                return
              }

              const submitted = draft
              run({
                save: () => command({ name: 'hydra', args: ['send', `--text=${submitted}`, '--event-id', crypto.randomUUID()] })
                  .then(() => setDraft(current => current === submitted ? '' : current))
                  .catch(e => notify({ text: e.message })),
              })
            }}
          >
            <Input
              aria-label="Message Hydra"
              placeholder="Message Hydra…"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={!connected}
            />
            <Button type="submit" disabled={!connected || busy || !draft.trim()}>Send to Hydra</Button>
          </form>
        </div>
      )}
    </section>
  )
}
