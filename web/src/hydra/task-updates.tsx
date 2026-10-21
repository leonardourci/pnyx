import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card, HydraColumn } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import type { Command } from './connection.ts'
import { loadRelevant, taskTimeline, type TaskEvent } from './task-updates.ts'

import { Disclosure } from '../components/ui/disclosure.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { hasTaskQuestion, TaskQuestion } from './task-question.tsx'

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

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let active = true

      const refresh = async () => {
        setLoading(true)

        try {
          const result = filled.current
            ? {
              found: await load({}),
              more: undefined,
            }
            : await loadRelevant({
              cardId: card.id,
              pageSize: PAGE_SIZE,
              load,
            })

          if (active) {
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
          if (active) {
            setError(error instanceof Error ? error.message : String(error))
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
      load,
      card.id,
      card.updatedSeq,
      retry,
    ],
  )

  const older = async () => {
    setLoading(true)

    try {
      const result = await loadRelevant({
        cardId: card.id,
        before: Math.min(...events.map(event => event.seq)),
        pageSize: PAGE_SIZE,
        load,
      })
      setEvents(kept => [
        ...kept,
        ...result.found.filter(event => !kept.some(prior => prior.id === event.id)),
      ])
      setMore(result.more); setError('')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
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
  const pending = hasTaskQuestion({ card }) ? (
    <li key="pending-question" className="pending-question">
      <TaskQuestion
        card={card}
        command={command}
        notify={notify}
        answer={answer}
      />
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
      {(updates.length > 0 || pending) && (
        <ol>
          {!oldestFirst && pending}
          {updates.map(update => (
            <li key={update.id}>
              <div className="update-heading">
                <strong>{stateLabel({ state: update.state })}</strong>
                <Tooltip content={new Date(update.at).toLocaleString()}>
                  <time dateTime={update.at} tabIndex={0}>{shortTime({ at: update.at })}</time>
                </Tooltip>
              </div>
              {update.decision ? (
                <Disclosure
                  className="decision"
                  title={(
                    <>
                      <span className="decision-line"><b>Asked</b> · {update.decision.question}</span>
                      <span className="decision-line"><b>Answered</b> · {update.decision.answer} · by {update.decision.actor}</span>
                    </>
                  )}
                >
                  <p><b>Question.</b> {update.decision.question}</p>
                  <p><b>Answer.</b> {update.decision.answer} · by {update.decision.actor}</p>
                  {update.decision.reason && <p><b>Why.</b> {update.decision.reason}</p>}
                </Disclosure>
              ) : update.note && <Markdown text={update.note} />}
            </li>
          ))}
          {oldestFirst && pending}
        </ol>
      )}
      {loading && <p className="muted" role="status">Loading updates…</p>}
      {!updates.length && !pending && !loading && !error && <p className="empty">No updates yet.</p>}
      {error && <p role="alert">{error} <Button disabled={!connected} onClick={() => setRetry(n => n + 1)}>Try again</Button></p>}
      {more && (
        <Button disabled={!connected || loading} onClick={() => void older()}>Older updates</Button>
      )}
    </div>
  )
}
