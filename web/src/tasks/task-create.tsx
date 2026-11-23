import { useSessionView, useSessionViewResource, sessionViewKey } from '#web-app/session-view.ts'
import { useTaskEditorFocus } from './task-view.ts'
import { useRef, useState, useSyncExternalStore } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { Composer } from '#web-hydra/composer.tsx'
import { useChatDrafts } from '#web-hydra/chat-drafts.ts'
import { hasPendingImage } from '#web-hydra/draft.ts'
import { useCardAgent, RepositoryPicker, type RepositoryOption } from '#web-workers/card-agent.tsx'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Command } from '#web-app/connection.ts'
import { DESCRIPTION_LIMIT_MESSAGE, descriptionExceedsLimit, taskDescription } from './description.ts'

export interface TaskDraft {
  title: string
  prompt: string
  attempt: string
  project?: string
  agent?: AgentConfig
}

export function TaskCreate({
  hydraId,
  storageIdentity,
  identity,
  version,
  project,
  repositories = [],
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
  hydraId: string
  version: number
  storageIdentity: string
  identity: string
  project?: string
  repositories?: RepositoryOption[]
  parent?: string
  before?: {
    task: string
    repositories: string[]
  }
  command: Command
  connected: boolean
  submitted(): void
  recover({ draft }: { draft: TaskDraft }): void
  draft?: TaskDraft
  cancel(): void
  notify({ text }: { text: string }): void
}) {
  const [
    title,
    setTitle,
  ] = useSessionView({
    key: sessionViewKey({
      scope: 'create',
      id: identity,
      field: 'title',
    }),
    initial: draft?.title ?? '',
  })
  const [
    busy,
    setBusy,
  ] = useState(false)
  const [
    repository,
    setRepository,
  ] = useSessionView({
    key: sessionViewKey({
      scope: 'create',
      id: identity,
      field: 'project',
    }),
    initial: draft?.project ?? project ?? '',
  })
  const [attemptId] = useSessionView({
    key: sessionViewKey({
      scope: 'create',
      id: identity,
      field: 'attempt',
    }),
    initial: draft?.attempt ?? crypto.randomUUID(),
  })
  const attempt = useRef(attemptId)
  const titleField = useRef<HTMLTextAreaElement>(null)
  useTaskEditorFocus({
    hydraId,
    id: `new:${attemptId}`,
    kind: 'edit',
    version,
    field: titleField,
  })
  const {
    agent,
    settings,
  } = useCardAgent({
    identity: attemptId,
    command,
    connected,
    initial: draft?.agent,
  })
  const prompt = useSessionViewResource({
    key: sessionViewKey({
      scope: 'create',
      id: identity,
      field: 'prompt',
    }),
    initial: draft?.prompt ?? '',
  })
  const drafts = useChatDrafts({
    text: prompt.snapshot(),
    identity: `new:${storageIdentity}:${attempt.current}`,
    commentsKey: `${storageIdentity}:new:${attempt.current}:comments`,
    saveText: ({ text }) => prompt.set(text),
  })
  const description = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.read().text,
  )
  const imagesLoading = hasPendingImage({ text: description })
  const descriptionTooLong = descriptionExceedsLimit({ text: description })
  const needsRepository = repositories.length > 1 && !repository
  const sameGroup = before && (repository
    ? before.repositories.includes(repository) : !before.repositories.length)
  const beforeTask = sameGroup
    ? before.task : undefined
  const disabled = !connected || busy || !title.trim() || imagesLoading || descriptionTooLong

  const save = async ({
    start = false,
    text = drafts.read().text,
  }: {
    start?: boolean
    text?: string
  } = {}) => {
    const invalidDescription = hasPendingImage({ text }) || descriptionExceedsLimit({ text })
    const missingRepository = start && needsRepository

    if (disabled || invalidDescription || missingRepository) {
      return
    }

    setBusy(true)
    const args = [
      'create',
      '--title',
      title.trim(),
    ]

    const savedDescription = taskDescription({ text })

    if (savedDescription) {
      args.push(`--brief=${savedDescription}`)
    }

    if (repository) {
      args.push(
        '--project',
        repository,
      )
    }

    if (beforeTask) {
      args.push(
        '--before',
        beforeTask,
      )
    }

    if (parent) {
      args.push(
        '--parent',
        parent,
      )
    }

    if (start) {
      args.push(
        '--start',
        '--harness',
        agent.harness,
      )

      for (const field of [
        'account',
        'model',
        'effort',
      ] as const) {
        if (agent[field]) {
          args.push(
            `--${field}`,
            agent[field],
          )
        }
      }
    } else {
      args.push('--no-start')
    }

    args.push(
      '--event-id',
      attempt.current,
    )
    const saving = command({
      name: 'task',
      args,
    })
    submitted()

    try {
      await saving
    } catch (error) {
      if (!(error instanceof CommandFailure) || error.outcome === 'refused') {
        recover({
          draft: {
            title,
            prompt: text,
            attempt: attempt.current,
            project: repository,
            agent,
          },
        })
      }

      notify({ text: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  return (
    <section
      className="task-create flex shrink-0 flex-col gap-2 rounded-card border border-line bg-surface p-3"
      aria-label={parent ? 'New subtask' : 'New task'}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          cancel()
        }
      }}
    >
      <Input
        ref={titleField}
        aria-label="Task title"
        placeholder="Task title"
        value={title}
        onChange={event => setTitle(event.target.value)}
      />
      <RepositoryPicker
        value={repository}
        repositories={repositories}
        change={({ value }) => setRepository(value)}
        disabled={!connected || busy}
      />
      <span className="eyebrow">Description</span>
      <Composer
        limitHeight={false}
        hydraId={hydraId}
        storageIdentity={storageIdentity}
        card={`new:${attempt.current}`}
        title={title}
        drafts={drafts}
        thread={null}
        loadComment={async () => {}}
        settings={settings}
        fieldLabel="Description"
        placeholder="What should happen?"
        sendLabel="Start worker"
        unavailable={disabled || !repository}
        command={async ({
          name,
          args,
          onChecking,
        }) => {
          if (name !== 'reply') {
            return command({
              name,
              args,
              onChecking,
            })
          }

          await save({
            start: true,
            text: args[1],
          })

          return {}
        }}
        notify={notify}
      />
      {descriptionTooLong && <p className="muted small">{DESCRIPTION_LIMIT_MESSAGE}</p>}
      <div className="flex min-w-0 items-center gap-2">
        <Button
          disabled={disabled}
          onClick={() => {
            void save().catch(() => {})
          }}
        >{busy ? 'Saving…' : 'Save task'}
        </Button>
        <Button disabled={busy} onClick={cancel}>Cancel</Button>
      </div>
    </section>
  )
}
