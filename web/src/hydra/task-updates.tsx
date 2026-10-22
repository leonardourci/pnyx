import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card, HydraColumn } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'
import { groupUpdates, loadRelevant, taskTimeline, type TaskEvent } from './task-updates.ts'
import { hasTaskQuestion, TaskQuestion } from './task-question.tsx'
import { UpdateGroupRow } from './update-rows.tsx'

const PAGE_SIZE = 50

export function TaskUpdates({
  card,
  columns,
  command,
  connected,
  notify,
  answer,
}: {
  card: Card
  columns: HydraColumn[]
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  answer({ card }: { card: Card }): void
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
  const filled = useRef(false)
  const generation = useRef(0)

  useEffect(
    () => {
      const current = ++generation.current

      if (!connected) {
        setLoading(false)

        return
      }

      const refresh = async () => {
        setLoading(true)

        try {
          const result = filled.current
            ? {
              found: await load({}),
              more: undefined,
            }
            : await loadRelevant({
              pageSize: PAGE_SIZE,
              load,
            })

          if (generation.current === current) {
            const gap = filled.current && result.found.length === PAGE_SIZE
              && !result.found.some(next => events.some(prior => prior.id === next.id))
            filled.current = true
            setEvents(kept => gap ? result.found : [
              ...result.found,
              ...kept.filter(event => !result.found.some(next => next.id === event.id)),
            ])

            if (gap || result.more !== undefined) {
              setMore(gap || !!result.more)
            }

            setError('')
          }
        } catch (error) {
          if (generation.current === current) {
            setError(error instanceof Error ? error.message : String(error))
          }
        } finally {
          if (generation.current === current) {
            setLoading(false)
          }
        }
      }

      void refresh()

      return () => {
        if (generation.current === current) {
          generation.current++
        }
      }
    },
    [
      connected,
      load,
      card.id,
      card.updatedSeq,
      retry,
    ],
  )

  const older = async () => {
    const current = generation.current
    setLoading(true)

    try {
      const result = await loadRelevant({
        before: Math.min(...events.map(event => event.seq)),
        pageSize: PAGE_SIZE,
        load,
      })

      if (generation.current !== current) {
        return
      }

      setEvents(kept => [
        ...kept,
        ...result.found.filter(event => !kept.some(prior => prior.id === event.id)),
      ])
      setMore(result.more); setError('')
    } catch (error) {
      if (generation.current === current) {
        setError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (generation.current === current) {
        setLoading(false)
      }
    }
  }

  const timeline = taskTimeline({
    card,
    events,
    columns,
  })
  const questionPending = hasTaskQuestion({
    card,
    answered: timeline.some(update => update.id === card.status?.id && !!update.decision),
  })
  const history = timeline.filter(update => !questionPending || update.id !== card.status?.id
    || update.state !== 'needs_you' || !!update.decision)
  const groups = groupUpdates({ updates: history.toReversed() })
  const shown = oldestFirst ? groups : groups.toReversed()
  const pending = questionPending ? (
    <li key="pending-question" className="pending-question">
      <div className="pending-question-panel">
        <div className="update-heading"><strong>Decision needed</strong></div>
        <TaskQuestion
          card={card}
          command={command}
          notify={notify}
          answer={answer}
        />
      </div>
    </li>
  ) : null

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
      {(shown.length > 0 || pending) && (
        <ol>
          {!oldestFirst && pending}
          {shown.map(group => <UpdateGroupRow key={group.updates[0]!.id} group={group} />)}
          {oldestFirst && pending}
        </ol>
      )}
      {loading && <p className="muted" role="status">Loading updates…</p>}
      {!shown.length && !pending && !loading && !error && <p className="empty">No updates yet.</p>}
      {error && <p role="alert">{error} <Button disabled={!connected} onClick={() => setRetry(n => n + 1)}>Try again</Button></p>}
      {more && (
        <Button disabled={!connected || loading} onClick={() => void older()}>Older updates</Button>
      )}
    </div>
  )
}
