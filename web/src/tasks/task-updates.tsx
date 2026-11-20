import { useEffect, useId, useState } from 'react'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Card } from '#tasks/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { groupUpdates, taskTimeline, updateLayout } from './task-updates.ts'
import { hasTaskQuestion } from './task-question.ts'
import { UpdateRow } from './update-rows.tsx'
import { useCardUpdates } from './use-card-updates.ts'

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
  const {
    list,
    loading,
    error,
    loadOlder,
    retry,
  } = useCardUpdates({
    task: card.id,
    command,
    connected,
    through: card.revision,
  })
  const events = list?.events ?? []
  useEffect(
    () => {
      if (connected && list?.older !== undefined && !error) {
        loadOlder()
      }
    },
    [
      list?.older,
      error,
      connected,
    ],
  )
  const [
    oldestFirst,
    setOldestFirst,
  ] = useState(false)
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
  const rows = shown.flatMap(group => group.updates.map((
    update,
    index,
  ) => ({
    group,
    update,
    index,
  })))
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
      className="task-updates min-h-0 flex-1 overflow-visible py-2 wrap-anywhere [&>ul]:m-0 [&>ul]:list-none [&>ul]:p-0"
      role="region"
      aria-label="Task updates"
      aria-busy={loading}
      tabIndex={0}
    >
      <div className="task-updates-head flex items-center justify-between gap-2 px-1">
        <h3 className="eyebrow">Updates</h3>
        <Button
          className="quiet updates-order px-1.5 py-0.5 text-meta text-muted"
          aria-label={oldestFirst ? 'Show newest updates first' : 'Show oldest updates first'}
          onClick={() => setOldestFirst(order => !order)}
        >{oldestFirst ? 'Oldest first ↑' : 'Newest first ↓'}
        </Button>
      </div>
      {shown.length > 0 && (
        <ul>
          {rows.map(item => (
            <UpdateRow
              key={item.update.id}
              update={item.update}
              group={item.group}
              index={item.index}
              prefix={id}
              open={nextLayout.open.has(item.group.updates[0]!.id)}
              toggle={() => toggle({ id: item.group.updates[0]!.id })}
            />
          ))}
        </ul>
      )}
      {loading && <p className="muted" role="status">Loading updates…</p>}
      {!shown.length && !loading && !error && <p className="empty">No updates yet.</p>}
      {error && <p role="alert">{error} <Button onClick={retry}>Try again</Button></p>}
    </div>
  )
}
