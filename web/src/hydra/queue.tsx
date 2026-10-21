import { useState } from 'react'
import type { Card, HydraState } from '../../../src/core/model.ts'
import { queuePosition, queueWorker, workerQueue } from '../../../src/queue/state.ts'
import { Button, Select } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function QueueLabel({
  card,
  state,
  open,
}: {
  card: Card
  state: HydraState
  open({ id }: { id: string }): void
}) {
  if (!card.queue) {
    return card.queueNote ? <small className="queue-note">{card.queueNote}</small> : null
  }

  const session = state.sessions?.[card.queue.session]
  const current = session?.taskId ? state.cards[session.taskId] : undefined

  return (
    <Button className="queue-label" onClick={() => current && open({ id: current.id })}>
      next for {current?.title ?? card.queue.session} · #{queuePosition({
        state,
        card,
      })?.position}
    </Button>
  )
}

export function WorkerQueue({
  card,
  state,
  open,
}: {
  card: Card
  state: HydraState
  open({ id }: { id: string }): void
}) {
  const session = card.sessionIds?.[0]
  const queue = session ? workerQueue({
    state,
    session,
  }) : []

  if (!queue.length) {
    return null
  }

  return (
    <div className="worker-queue" aria-label={`Queue for ${card.title}`}>
      <strong>Next for this worker</strong>
      <ol>{queue.map(task => (
        <li key={task.id}>
          <Button onClick={() => open({ id: task.id })}>{task.title}</Button>
        </li>
      ))}
      </ol>
    </div>
  )
}

export function QueueEditor({
  card,
  state,
  command,
  connected,
  close,
}: {
  card: Card
  state: HydraState
  command: Command
  connected: boolean
  close(): void
}) {
  const workers = Object.values(state.sessions ?? {}).filter(session =>
    card.project && queueWorker({
      state,
      session,
    })?.project === card.project)
  const options = workers.flatMap(session => [
    {
      value: session.id,
      label: `Last for ${state.cards[session.taskId!]!.title}`,
    },
    ...workerQueue({
      state,
      session: session.id,
    }).filter(t => t.id !== card.id)
      .map(task => ({
        value: task.id,
        label: `After ${task.title}`,
      })),
  ])
  const [
    behind,
    setBehind,
  ] = useState(card.queue?.session ?? options[0]?.value ?? '')
  const [
    busy,
    setBusy,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState('')

  const save = async ({ remove = false }: { remove?: boolean } = {}) => {
    setBusy(true)
    setError('')

    try {
      await command({
        name: 'task',
        args: [
          remove ? 'unqueue' : 'queue',
          card.id,
          ...(!remove ? [
            '--behind',
            behind,
          ] : []),
          '--if-revision',
          String(card.revision),
          '--event-id',
          crypto.randomUUID(),
        ],
      })
      close()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="queue-editor"
      aria-label={`Queue ${card.title}`}
      onSubmit={event => {
        event.preventDefault(); void save()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation(); close()
        }
      }}
    >
      <strong>Queue related work</strong>
      {options.length ? (
        <Select
          label="Queue behind"
          value={behind}
          options={options}
          disabled={!connected || busy}
          onChange={({ value }) => setBehind(value)}
        />
      )
        : <p className="muted">No live worker in this project.</p>}
      <small className="muted">
        Use a worker changing the same files. Starts after its current work lands.
      </small>
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <Button type="submit" disabled={!connected || busy || !behind}>Save queue</Button>
        {card.queue && (
          <Button disabled={!connected || busy} onClick={() => void save({ remove: true })}>
            Unqueue
          </Button>
        )}
        <Button disabled={busy} onClick={close}>Cancel</Button>
      </div>
    </form>
  )
}
