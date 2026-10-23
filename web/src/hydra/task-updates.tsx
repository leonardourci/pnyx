import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Card, HydraColumn } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'
import { groupUpdates, taskTimeline } from './task-updates.ts'
import { loadOlderUpdates, loadUpdates, retryUpdates, subscribeUpdates, updatesOf } from './updates-cache.ts'
import { hasTaskQuestion, TaskQuestion } from './task-question.tsx'
import { UpdateGroupRow } from './update-rows.tsx'

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
  const {
    events,
    more,
    loaded,
    stale,
    error,
  } = useSyncExternalStore(
    subscribeUpdates,
    () => updatesOf({ id: card.id }),
  )
  const [
    paging,
    setPaging,
  ] = useState(false)
  const [
    oldestFirst,
    setOldestFirst,
  ] = useState(false)

  useEffect(
    () => {
      if (connected) {
        void loadUpdates({
          command,
          id: card.id,
        })
      }
    },
    [
      connected,
      command,
      card.id,
      loaded,
      stale,
    ],
  )

  const older = async () => {
    setPaging(true)

    try {
      await loadOlderUpdates({
        command,
        id: card.id,
      })
    } finally {
      setPaging(false)
    }
  }

  const retry = () => void retryUpdates({
    command,
    id: card.id,
  })

  // Only the first read and Older updates show loading; a refresh keeps the list as it is.
  const loading = paging || (connected && !loaded && !error)
  const timeline = taskTimeline({
    card,
    events,
    columns,
  })
  const questionPending = hasTaskQuestion({
    card,
  })
  // An open question to the owner shows in the pending panel, not twice.
  const history = timeline.filter(update => (!questionPending || update.id !== card.status?.id
    || update.state !== 'needs_you' || !!update.decision)
    && !card.asks?.some(ask => ask.id === update.id && ask.audience === 'owner' && !ask.answered && !ask.closed))
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
      {error && (
        <p role="alert">{error} <Button disabled={!connected} onClick={retry}>Try again</Button></p>
      )}
      {more && (
        <Button disabled={!connected || loading} onClick={older}>Older updates</Button>
      )}
    </div>
  )
}
