import { useRef, useState } from 'react'
import { Button, Input, Textarea } from '../components/ui/controls.tsx'
import type { Command } from './connection.ts'

export function TaskCreate({
  column,
  parent,
  command,
  connected,
  saved,
  cancel,
  notify,
}: {
  column: string
  parent?: string
  command: Command
  connected: boolean
  saved({ id }: { id: string }): void
  cancel(): void
  notify({ text }: { text: string }): void
}) {
  const [
      title,
      setTitle,
    ] = useState(''), [
      prompt,
      setPrompt,
    ] = useState(''), [
      busy,
      setBusy,
    ] = useState(false)
  const attempt = useRef(crypto.randomUUID())

  return (
    <form
      className="task-create"
      aria-label={parent ? 'New subtask' : 'New task'}
      onSubmit={e => {
        e.preventDefault()

        if (busy || !title.trim()) {
          return
        }

        setBusy(true)
        void command({
          name: 'task',
          args: [
            'create',
            '--title',
            title.trim(),
            '--ask',
            prompt,
            '--column',
            column,
            ...(parent ? [
              '--parent',
              parent,
            ] : []),
            '--event-id',
            attempt.current,
          ],
        })
          .then(receipt => saved({ id: (receipt.card as { id: string }).id }))
          .catch(error => notify({ text: error.message }))
          .finally(() => setBusy(false))
      }}
      onKeyDown={e => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation(); cancel()
        }
      }}
    >
      <Input
        autoFocus
        aria-label="Task title"
        placeholder="Task title"
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <Textarea
        aria-label="Your ask"
        placeholder="What should happen?"
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
      />
      <div className="row">
        <Button type="submit" disabled={!connected || busy || !title.trim()}>{busy ? 'Saving…' : 'Save task'}</Button>
        <Button disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
    </form>
  )
}
