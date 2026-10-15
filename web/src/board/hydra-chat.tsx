import { readAttempt, saveAttempt } from './outbox.ts'
import { useEffect, useRef, useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import { HYDRA_CARD, boardConfig } from '../../../src/core/hydra.ts'
import { Button, Textarea, useBusy } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'
import { InlineQuestions } from './questions.tsx'

export function HydraChat({ state, command, connected, openTask, notify }: {
  state: BoardState
  command: Command
  connected: boolean
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem('pnyx-hydra-draft') ?? ''
    } catch {
      return ''
    }
  })
  const attempt = useRef(readAttempt({ key: '$hydra' }))
  const [failure, setFailure] = useState('')
  useEffect(() => {
    sessionStorage.setItem('pnyx-hydra-draft', draft)
  }, [draft])
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

    if (busy) {
      return
    }

    setFailure('')
    const submitted = draft

    if (attempt.current?.text !== submitted) {
      attempt.current = { text: submitted, id: crypto.randomUUID(), pending: true }
    }

    attempt.current.pending = true
    saveAttempt({ key: '$hydra', attempt: attempt.current })
    const id = attempt.current.id
    run({
      save: () => command({ name: 'hydra', args: ['send', `--text=${submitted}`, '--event-id', id] })
        .then(() => {
          attempt.current = null
          setDraft(current => current === submitted ? '' : current)
        })
        .catch(e => setFailure(e.message))
        .finally(() => {
          if (attempt.current) {
            attempt.current.pending = false
          }

          saveAttempt({ key: '$hydra', attempt: attempt.current })
        }),
    })
  }

  useEffect(() => {
    if (attempt.current?.pending && attempt.current.text === draft) {
      send()
    }
  }, [])

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
        {state.cards[HYDRA_CARD] && (
          <InlineQuestions
            card={state.cards[HYDRA_CARD]}
            command={command}
            connected={connected}
            notify={notify}
          />
        )}
        <div ref={end} />
      </div>
      {failure && <p className="small" role="status">{failure}</p>}
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
        />
        <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>Send</Button>
      </form>
    </aside>
  )
}
