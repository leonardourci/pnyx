import { useSessionView } from '#web-app/session-view.ts'
import { taskViewKey, useTaskEditorFocus } from './task-view.ts'
import { useRef } from 'react'
import type { Card } from '#tasks/model.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { ComposerField, type ComposerFieldHandle } from '#web-titan/composer-field.tsx'
import { hasPendingImage } from '#web-titan/draft.ts'
import { DESCRIPTION_LIMIT_MESSAGE, descriptionExceedsLimit, taskDescription } from './description.ts'
import type { Command } from '#web-app/connection.ts'

export interface TaskDraft {
  title: string
  brief: string
}

export function TaskEditor({
  titanId,
  card,
  version,
  draft,
  command,
  close,
  failed,
}: {
  titanId: string
  card: Card
  version: number
  draft?: TaskDraft
  command: Command
  close(): void
  failed({
    draft,
    error,
  }: {
    draft: TaskDraft
    error: Error
  }): void
}) {
  const [
    title,
    setTitle,
  ] = useSessionView({
    key: taskViewKey({
      titanId,
      id: card.id,
      field: 'editor.title',
    }),
    initial: draft?.title ?? card.title,
  })
  const [
    brief,
    setBrief,
  ] = useSessionView({
    key: taskViewKey({
      titanId,
      id: card.id,
      field: 'editor.brief',
    }),
    initial: draft?.brief ?? card.brief ?? '',
  })
  const titleField = useRef<HTMLTextAreaElement>(null)
  const briefField = useRef<ComposerFieldHandle>(null)
  useTaskEditorFocus({
    titanId,
    id: card.id,
    kind: 'edit',
    version,
    field: titleField,
  })

  const imagesLoading = hasPendingImage({ text: brief })
  const nextBrief = taskDescription({ text: brief })
  const tooLong = descriptionExceedsLimit({ text: brief })
  const blocked = imagesLoading || tooLong
  const blockedReason = imagesLoading ? 'Images are still loading' : DESCRIPTION_LIMIT_MESSAGE

  const save = () => {
    const nextTitle = title.replace(
      /\s+/g,
      ' ',
    ).trim()

    if (blocked) {
      return
    }

    const saving = [
      ...(nextTitle && nextTitle !== card.title ? [
        command({
          name: 'task',
          args: [
            'rename',
            card.id,
            '--title',
            nextTitle,
            '--event-id',
            crypto.randomUUID(),
          ],
        }),
      ] : []),
      ...(nextBrief !== (card.brief ?? '') ? [
        command({
          name: 'task',
          args: [
            'brief',
            card.id,
            `--brief=${nextBrief}`,
            '--event-id',
            crypto.randomUUID(),
          ],
        }),
      ] : []),
    ]
    close()
    void Promise.all(saving).catch((error: unknown) => failed({
      draft: {
        title,
        brief,
      },
      error: error instanceof Error ? error : new Error(String(error)),
    }))
  }

  return (
    <form
      className="task-editor flex flex-col gap-1.5 [&>.row]:flex-wrap"
      aria-label="Edit title and description"
      onSubmit={event => {
        event.preventDefault(); save()
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) {
          return
        }

        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault(); event.stopPropagation(); save()
        }
      }}
    >
      <Input
        ref={titleField}
        aria-label="Task title"
        value={title}
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) {
            event.preventDefault(); briefField.current?.input?.focus()
          }
        }}
      />
      <span className="eyebrow">Description</span>
      <ComposerField
        ref={briefField}
        label="Description"
        placeholder="Describe the task…"
        value={brief}
        change={({ text }) => setBrief(text)}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={blocked}>Save</Button>
        <Button onClick={close}>Cancel</Button>
        <span className="muted small">{blocked ? blockedReason : '⌘/Ctrl+Enter saves · Esc cancels'}</span>
      </div>
    </form>
  )
}
