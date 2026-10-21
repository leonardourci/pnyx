import { useCallback, useEffect, useState } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import type { Command } from './connection.ts'
import { taskTimeline, type TaskEvent } from './task-updates.ts'

const PAGE_SIZE = 50

const stateLabel = ({ state }: { state: string }) =>
  state === 'needs_you' ? 'Needs you' : state.replace(
    /^./,
    c => c.toUpperCase(),
  )

const shortTime = ({ at }: { at: string }) => new Date(at).toLocaleString(
  [],
  {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
)

export function TaskUpdates({
  card,
  command,
  connected,
}: {
  card: Card
  command: Command
  connected: boolean
}) {
  const [
    events,
    setEvents,
  ] = useState<TaskEvent[]>([])
  const [
    more,
    setMore,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState('')
  const [
    loading,
    setLoading,
  ] = useState(false)
  const [
    retry,
    setRetry,
  ] = useState(0)
  const load = useCallback(
    async ({ before }: { before?: number }) => {
      const result = await command({
        name: 'history',
        args: [
          '--card',
          card.id,
          '--full',
          '--limit',
          String(PAGE_SIZE),
          ...(before ? [
            '--before',
            String(before),
          ] : []),
        ],
      })

      return Array.isArray(result.events) ? result.events as TaskEvent[] : []
    },
    [
      command,
      card.id,
    ],
  )

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let active = true
      setLoading(true)
      void load({}).then(
        page => {
          if (active) {
            setEvents(kept => page.some(event => kept.some(prior => prior.id === event.id))
              ? [
                ...page,
                ...kept.filter(event => !page.some(next => next.id === event.id)),
              ] : page)
            setMore(page.length === PAGE_SIZE); setError('')
          }
        },
        (error: Error) => {
          if (active) {
            setError(error.message)
          }
        },
      )
        .finally(() => {
          if (active) {
            setLoading(false)
          }
        })

      return () => {
        active = false
      }
    },
    [
      connected,
      load,
      card.updatedSeq,
      retry,
    ],
  )

  const updates = taskTimeline({
    card,
    events,
  })

  return (
    <div
      className="task-updates"
      role="region"
      aria-label="Task updates"
      tabIndex={0}
    >
      <h3 className="eyebrow">Updates</h3>
      <InlinePermissions card={card} command={command} notify={({ text }) => setError(text)} />
      <InlineQuestions card={card} command={command} notify={({ text }) => setError(text)} />
      {updates.length > 0 && (
        <ol>
          {updates.map(update => (
            <li key={update.id}>
              <div className="update-heading">
                <strong>{stateLabel({ state: update.state })}</strong>
                <time dateTime={update.at} title={new Date(update.at).toLocaleString()}>
                  {shortTime({ at: update.at })}
                </time>
              </div>
              {update.note && <Markdown text={update.note} />}
            </li>
          ))}
        </ol>
      )}
      {loading && <p className="muted" role="status">Loading updates…</p>}
      {!updates.length && !loading && !error && <p className="empty">No updates yet.</p>}
      {error && <p role="alert">{error} <Button disabled={!connected} onClick={() => setRetry(n => n + 1)}>Try again</Button></p>}
      {more && (
        <Button
          disabled={!connected || loading}
          onClick={() => {
            setLoading(true)
            void load({ before: Math.min(...events.map(event => event.seq)) }).then(
              page => {
                setEvents(kept => [
                  ...kept,
                  ...page.filter(event => !kept.some(prior => prior.id === event.id)),
                ])
                setMore(page.length === PAGE_SIZE); setError('')
              },
              (error: Error) => setError(error.message),
            )
              .finally(() => setLoading(false))
          }}
        >Older updates
        </Button>
      )}
    </div>
  )
}
