import { useCallback, useEffect, useState } from 'react'
import type { Card, HydraColumn } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import type { Command } from './connection.ts'
import { relevantUpdate, taskTimeline, type TaskEvent } from './task-updates.ts'

const PAGE_SIZE = 50
const MIN_ROWS = 20

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
  columns,
  command,
  connected,
}: {
  card: Card
  columns: HydraColumn[]
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
  const [
    oldestFirst,
    setOldestFirst,
  ] = useState(false)
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
  // Most raw events are not shown, so keep paging back until a screenful is.
  const loadRelevant = useCallback(
    async ({
      before,
      kept,
    }: {
      before?: number
      kept: TaskEvent[]
    }) => {
      let page = await load({ before })
      const found = [
        ...kept,
        ...page,
      ]
      const shown = () => found.filter(event => relevantUpdate({
        cardId: card.id,
        event,
        columns: [],
      })).length

      while (page.length === PAGE_SIZE && shown() < MIN_ROWS) {
        page = await load({ before: Math.min(...page.map(event => event.seq)) })
        found.push(...page)
      }

      return {
        found,
        more: page.length === PAGE_SIZE,
      }
    },
    [
      load,
      card.id,
    ],
  )

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let active = true

      const refresh = async () => {
        setLoading(true)

        try {
          const result = await loadRelevant({ kept: [] })

          if (active) {
            setEvents(kept => result.found.some(event => kept.some(prior => prior.id === event.id))
              ? [
                ...result.found,
                ...kept.filter(event => !result.found.some(next => next.id === event.id)),
              ] : result.found)
            setMore(result.more); setError('')
          }
        } catch (error) {
          if (active) {
            setError((error as Error).message)
          }
        } finally {
          if (active) {
            setLoading(false)
          }
        }
      }

      void refresh()

      return () => {
        active = false
      }
    },
    [
      connected,
      loadRelevant,
      card.updatedSeq,
      retry,
    ],
  )

  const older = async () => {
    setLoading(true)

    try {
      const result = await loadRelevant({
        before: Math.min(...events.map(event => event.seq)),
        kept: events,
      })
      setEvents(result.found)
      setMore(result.more); setError('')
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const timeline = taskTimeline({
    card,
    events,
    columns,
  })
  const updates = oldestFirst ? timeline.toReversed() : timeline

  return (
    <div
      className="task-updates"
      role="region"
      aria-label="Task updates"
      tabIndex={0}
    >
      <div className="task-updates-head">
        <h3 className="eyebrow">Updates</h3>
        <Button
          className="quiet updates-order"
          aria-label={oldestFirst ? 'Show newest updates first' : 'Show oldest updates first'}
          onClick={() => setOldestFirst(order => !order)}
        >{oldestFirst ? 'Oldest first ↑' : 'Newest first ↓'}
        </Button>
      </div>
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
        <Button disabled={!connected || loading} onClick={() => void older()}>Older updates</Button>
      )}
    </div>
  )
}
