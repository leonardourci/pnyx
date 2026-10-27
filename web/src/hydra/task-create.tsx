import { useRef, useState } from 'react'
import { Button, Input, Textarea } from '../shared/ui/controls.tsx'
import { CommandFailure } from '../shared/pending-intents.ts'
import type { Command } from './connection.ts'

export interface TaskDraft {
  title: string
  prompt: string
  attempt: string
}

export function TaskCreate({
  column,
  parent,
  command,
  connected,
  submitted,
  recover,
  draft,
  cancel,
  notify,
}: {
  column: string
  parent?: string
  command: Command
  connected: boolean
  submitted({ id }: { id: string }): void
  recover({ draft }: { draft: TaskDraft }): void
  draft?: TaskDraft
  cancel(): void
  notify({ text }: { text: string }): void
}) {
  const [
      title,
      setTitle,
    ] = useState(draft?.title ?? ''), [
      prompt,
      setPrompt,
    ] = useState(draft?.prompt ?? ''), [
      busy,
      setBusy,
    ] = useState(false)
  const attempt = useRef(draft?.attempt ?? crypto.randomUUID())

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
        const saving = command({
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
        submitted({ id: `task:${attempt.current}` })
        void saving.catch((error: Error) => {
          if (!(error instanceof CommandFailure) || error.outcome === 'refused') {
            recover({
              draft: {
                title,
                prompt,
                attempt: attempt.current,
              },
            })
          }

          notify({ text: error.message })
        })
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
