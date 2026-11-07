import { useRef, useState } from 'react'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { ComposerField } from '#web-hydra/composer-field.tsx'
import { hasPendingImage } from '#web-hydra/draft.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Command } from '#web-app/connection.ts'

export interface TaskDraft {
  title: string
  prompt: string
  attempt: string
}

export function TaskCreate({
  column,
  parent,
  before,
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
  before?: string
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
  const imagesLoading = hasPendingImage({ text: prompt })

  return (
    <form
      className="task-create"
      aria-label={parent ? 'New subtask' : 'New task'}
      onSubmit={e => {
        e.preventDefault()

        if (busy || !title.trim() || imagesLoading) {
          return
        }

        setBusy(true)
        const args = [
          'create',
          '--title',
          title.trim(),
          '--ask',
          prompt,
          '--column',
          column,
        ]

        if (before) {
          args.push(
            '--before',
            before,
          )
        }

        if (parent) {
          args.push(
            '--parent',
            parent,
          )
        }

        args.push(
          '--event-id',
          attempt.current,
        )
        const saving = command({
          name: 'task',
          args,
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
      <ComposerField
        label="Your ask"
        placeholder="What should happen?"
        value={prompt}
        change={({ text }) => setPrompt(text)}
      />
      <div className="row">
        <Button type="submit" disabled={!connected || busy || !title.trim() || imagesLoading}>{busy ? 'Saving…' : 'Save task'}</Button>
        <Button disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
    </form>
  )
}
