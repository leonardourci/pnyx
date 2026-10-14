import { useEffect, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import type { Command } from './connection.ts'

interface Note { at: string; source: string; text: string }
const SECTIONS = [['summary', 'Summary'], ['decisions', 'Decisions'], ['context', 'Context']] as const

// The card's harvested notes, in full, as `pnyx-axi card --full` reports them.
export function Notes({
  card,
  command,
  notify,
}: {
  card: Card
  command: Command
  notify(text: string): void
}) {
  const [notes, setNotes] = useState<Record<string, Note[]> | null>(null)
  useEffect(() => {
    let cancelled = false
    void command('card', [card.id, '--full']).then(r => {
      if (!cancelled) {
        setNotes(Object.fromEntries(SECTIONS.map(([key]) => {
          const list = (r.notes as Record<string, unknown> | undefined)?.[key]

          return [key, Array.isArray(list) ? list as Note[] : []]
        })))
      }
    })
      .catch(e => {
        if (!cancelled) {
          notify(e.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [card.id, card.notes?.length, command, notify])

  if (!notes) {
    return <div className="detail-content"><p className="empty">Loading notes…</p></div>
  }

  return (
    <div className="detail-content">
      <span className="eyebrow">Summary · Decisions · Context</span>
      {SECTIONS.map(([key, title]) => (
        <section key={key} aria-label={title}>
          <h3>{title}</h3>
          {notes[key]!.length ? notes[key]!.map((n, i) => (
            <article key={i} className="history-entry">
              <p>{n.text}</p>
              <span className="small muted">
                {n.source}
                {' '}
                ·
                {' '}
                {new Date(n.at).toLocaleString()}
              </span>
            </article>
          )) : <p className="empty">Nothing recorded yet.</p>}
        </section>
      ))}
    </div>
  )
}
