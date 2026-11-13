import { useId, useState } from 'react'
import { useQuery } from '@rocicorp/zero/react'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Card } from '#tasks/model.ts'
import type { TaskEvent } from '#tasks/updates.ts'
import { HISTORY_PAGE, queries } from '#store/zero-schema.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { groupUpdates, olderUpdates, taskTimeline, updateLayout } from './task-updates.ts'
import { hasTaskQuestion } from './task-question.ts'
import { UpdateRow } from './update-rows.tsx'

// The card's Updates, newest first, as Zero syncs them: the events its card_updates rows list.
export function TaskUpdates({
  card,
  columns,
  hydraId,
}: {
  card: Card
  columns: HydraColumn[]
  hydraId: string
}) {
  const [
    limit,
    setLimit,
  ] = useState(HISTORY_PAGE)
  const [
    rows,
    result,
  ] = useQuery(queries.card.history({
    hydraId,
    cardId: card.id,
    limit,
  }))
  // A row whose event Zero has not synced yet shows once it has. Zero types json columns as plain JSON; each event's
  // data is the HydraEvent the server stored.
  const events = rows.flatMap(row => row.event ? [row.event.data as TaskEvent] : [])
  const error = result.type === 'error' ? result : undefined
  const loaded = result.type === 'complete' || result.type === 'cached'
  const older = () => setLimit(current => current + HISTORY_PAGE)
  const [
    oldestFirst,
    setOldestFirst,
  ] = useState(false)
  const loading = !loaded && !error
  const more = olderUpdates({
    rows: rows.length,
    limit,
    loading,
  })
  const timeline = taskTimeline({
    card,
    events,
    columns,
  })
  const questionPending = hasTaskQuestion({
    card,
  })
  // An open question to the owner shows on the card's Context tab, not here too.
  const history = timeline.filter(update => (!questionPending || update.id !== card.status?.id
    || update.state !== 'needs_you' || !!update.decision)
    && !card.asks?.some(ask => ask.id === update.id && ask.audience === 'owner' && !ask.answered && !ask.closed))
  const groups = groupUpdates({ updates: history.toReversed() })
  const shown = oldestFirst ? groups : groups.toReversed()
  const id = useId()
  const [
    layout,
    setLayout,
  ] = useState(() => updateLayout({ groups }))
  const nextLayout = updateLayout({
    groups,
    previous: layout,
  })

  if (nextLayout !== layout) {
    setLayout(nextLayout)
  }

  const toggle = ({ id }: { id: string }) => setLayout(current => {
    const open = new Set(current.open)

    if (open.has(id)) {
      open.delete(id)
    } else {
      open.add(id)
    }

    return {
      ...current,
      open,
    }
  })

  return (
    <div
      className="task-updates"
      role="region"
      aria-label="Task updates"
      aria-busy={loading}
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
      {shown.length > 0 && (
        <ol>
          {shown.flatMap(group => group.updates.map((
            update,
            index,
          ) => (
            <UpdateRow
              key={update.id}
              update={update}
              group={group}
              index={index}
              prefix={id}
              open={nextLayout.open.has(group.updates[0]!.id)}
              toggle={() => toggle({ id: group.updates[0]!.id })}
            />
          )))}
        </ol>
      )}
      {loading && <p className="muted" role="status">Loading updates…</p>}
      {!shown.length && !loading && !error && <p className="empty">No updates yet.</p>}
      {error && <p role="alert">{error.error.message} <Button onClick={error.retry}>Try again</Button></p>}
      {more !== 'hidden' && (
        <Button disabled={more === 'loading'} onClick={older}>Older updates</Button>
      )}
    </div>
  )
}
