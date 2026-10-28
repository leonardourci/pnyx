import { useEffect, useRef, useState } from 'react'
import type { Card } from '#tasks/model.ts'
import { Button, Input, Textarea } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'

export interface TaskDraft {
  title: string
  brief: string
}

// Only the fields that changed are sent; automatic tasks have no brief to edit.
export function TaskEditor({
  card,
  draft,
  command,
  close,
  failed,
}: {
  card: Card
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
  ] = useState(draft?.title ?? card.title)
  const [
    brief,
    setBrief,
  ] = useState(draft?.brief ?? card.brief ?? '')
  const titleField = useRef<HTMLInputElement>(null)
  const briefField = useRef<HTMLTextAreaElement>(null)
  useEffect(
    () => {
      const field = titleField.current
      field?.focus({ preventScroll: true })
      field?.setSelectionRange(
        field.value.length,
        field.value.length,
      )
    },
    [],
  )

  const save = () => {
    const nextTitle = title.replace(
      /\s+/g,
      ' ',
    ).trim()
    const nextBrief = brief.trim()
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
      ...(!card.automaticTask && nextBrief !== (card.brief ?? '').trim() ? [
        command({
          name: 'task',
          args: [
            'brief',
            card.id,
            '--brief',
            nextBrief,
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
      className="task-editor"
      aria-label="Edit title and brief"
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
            event.preventDefault(); briefField.current?.focus()
          }
        }}
      />
      {!card.automaticTask && (
        <>
          <span className="eyebrow">Brief</span>
          <Textarea
            ref={briefField}
            aria-label="Brief"
            placeholder="Add a brief…"
            maxLength={24000}
            value={brief}
            onChange={event => setBrief(event.target.value)}
          />
        </>
      )}
      <div className="row">
        <Button type="submit" variant="primary">Save</Button>
        <Button onClick={close}>Cancel</Button>
        <span className="muted small">⌘/Ctrl+Enter saves · Esc cancels</span>
      </div>
    </form>
  )
}
