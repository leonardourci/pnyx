import { useRef, useState, useSyncExternalStore } from 'react'
import type { AgentConfig } from '#workers/model.ts'
import { Button, Input } from '#web-shared/ui/controls.tsx'
import { Composer } from '#web-hydra/composer.tsx'
import { useChatDrafts } from '#web-hydra/chat-drafts.ts'
import { hasPendingImage } from '#web-hydra/draft.ts'
import { useCardAgent, RepositoryPicker, type RepositoryOption } from '#web-workers/card-agent.tsx'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Command } from '#web-app/connection.ts'

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
  column,
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
  storageIdentity: string
  column: string
  project?: string
  repositories?: RepositoryOption[]
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
  ] = useState(draft?.title ?? '')
  const [
    busy,
    setBusy,
  ] = useState(false)
  const [
    repository,
    setRepository,
  ] = useState(draft?.project ?? project ?? '')
  const attempt = useRef(draft?.attempt ?? crypto.randomUUID())
  const {
    agent,
    settings,
  } = useCardAgent({
    command,
    connected,
    initial: draft?.agent,
  })
  const drafts = useChatDrafts({
    text: draft?.prompt ?? '',
    commentsKey: `${storageIdentity}:new:${attempt.current}:comments`,
    saveText: () => {},
  })
  const imagesLoading = useSyncExternalStore(
    drafts.subscribe,
    () => hasPendingImage({ text: drafts.read().text }),
  )
  const needsRepository = repositories.length > 1 && !repository
  const disabled = !connected || busy || !title.trim() || imagesLoading

  const save = async ({
    start = false,
    text = drafts.read().text,
  }: {
    start?: boolean
    text?: string
  } = {}) => {
    if (disabled || hasPendingImage({ text }) || needsRepository && start) {
      return
    }

    setBusy(true)
    const args = [
      'create',
      '--title',
      title.trim(),
      '--ask',
      text,
      '--column',
      column,
    ]

    if (repository) {
      args.push(
        '--project',
        repository,
      )
    }

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
        autoFocus
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
      <Composer
        hydraId={hydraId}
        storageIdentity={storageIdentity}
        card={`new:${attempt.current}`}
        title={title}
        drafts={drafts}
        thread={null}
        loadComment={async () => {}}
        settings={settings}
        fieldLabel="Your ask"
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
