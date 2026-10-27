import { useEffect, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import { CollapsibleText, Disclosure } from '../shared/ui/disclosure.tsx'
import { briefNotes, relativeTime, type BriefNote } from './brief.ts'
import type { Command } from './connection.ts'

type Sections = Record<'summary' | 'decisions' | 'context', BriefNote[]>

const list = ({ value }: { value: unknown }) => (Array.isArray(value) ? value as BriefNote[] : [])
const STATUS = /^(?:done|resolved|needs-decision)(?: \[[^\]]+\])?:\s*/

export function ConversationBrief({
  card,
  entries,
  command,
  notify,
}: {
  card: Card
  entries: ThreadEntry[]
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    notes,
    setNotes,
  ] = useState<Sections>({
    summary: [],
    decisions: [],
    context: [],
  })
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        60000,
      )

      return () => clearInterval(timer)
    },
    [],
  )
  useEffect(
    () => {
      let cancelled = false
      void command({
        name: 'card',
        args: [
          card.id,
          '--full',
        ],
      }).then(r => {
        const data = r.notes as Record<string, unknown> | undefined

        if (!cancelled) {
          setNotes({
            summary: list({ value: data?.summary }),
            decisions: list({ value: data?.decisions }),
            context: list({ value: data?.context }),
          })
        }
      })
        .catch(e => {
          if (!cancelled) {
            notify({ text: e.message })
          }
        })

      return () => {
        cancelled = true
      }
    },
    [
      card.id,
      card.notes?.length,
      command,
      notify,
    ],
  )

  const conversation = entries.filter(e => e.kind === 'message').map(e => e.text)
  const [
    summary,
    ...earlier
  ] = briefNotes({
    notes: notes.summary,
    conversation,
  })
  const decisions = briefNotes({
    notes: notes.decisions,
    conversation,
  })
  const context = briefNotes({
    notes: notes.context,
    conversation,
  })

  if (!summary && !decisions.length && !context.length) {
    return null
  }

  const meta = ({ note }: { note: BriefNote }) => (
    <span className="brief-meta">
      {note.source}
      {' · '}
      <time dateTime={note.at} title={note.at ? new Date(note.at).toLocaleString() : undefined}>
        {relativeTime({
          at: note.at,
          now,
        })}
      </time>
    </span>
  )

  const items = [
    ...decisions.map(note => [
      note.text.startsWith('needs-decision') ? 'Decision requested' : 'Decision',
      note,
    ] as const),
    ...context.map(note => [
      'Context',
      note,
    ] as const),
    ...earlier.map(note => [
      'Earlier summary',
      note,
    ] as const),
  ]

  return (
    <Disclosure
      className="conversation-brief"
      title={(
        <>
          <span className="eyebrow">
            Summary & decisions
            {decisions.length ? ` · ${decisions.length}` : ''}
          </span>
          <span className="brief-line">
            {summary?.text.replace(
              STATUS,
              '',
            ).split('\n')[0] ?? (decisions.length ? 'Recorded decisions' : 'Context')}
          </span>
        </>
      )}
    >
      {summary && (
        <div className="brief-item">
          <CollapsibleText
            text={summary.text.replace(
              STATUS,
              '',
            )}
          />
          {meta({ note: summary })}
        </div>
      )}
      {items.map((
        [
          label,
          note,
        ],
        i,
      ) => (
        <article className="brief-item" key={`${label}-${note.at}-${i}`}>
          <span className="eyebrow">{label}</span>
          <CollapsibleText
            text={note.text.replace(
              STATUS,
              '',
            )}
          />
          {meta({ note })}
        </article>
      ))}
    </Disclosure>
  )
}
