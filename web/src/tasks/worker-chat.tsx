import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { stored, save as saveLocal } from '#web-app/connection-storage.ts'
import type { Command } from '#web-app/connection.ts'
import { Messages, type ChatEntry } from '#web-hydra/messages.tsx'
import { Composer } from '#web-hydra/composer.tsx'
import { useChatDrafts, useDraftSnapshot } from '#web-hydra/chat-drafts.ts'
import { pnyxLookup } from '#web-hydra/pnyx-action.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { CommandFailure, createPendingResource } from '#web-shared/pending-intents.ts'

const replies = new Map<string, ReturnType<typeof createPendingResource<ChatEntry[], ChatEntry>>>()

export function WorkerChat({
  hydraId,
  storageIdentity,
  card,
  state,
  live,
  command,
  connected,
  notify,
}: {
  hydraId: string
  storageIdentity: string
  card: Card
  state: HydraState
  live: ThreadPage | null | undefined
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const installation = document.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content
  const key = `${location.origin}:${installation}:${hydraId}:${card.id}`
  const [resource] = useState(() => {
    const existing = replies.get(key)

    if (existing) {
      return existing
    }

    const created = createPendingResource<ChatEntry[], ChatEntry>({
      scope: key,
      confirmed: [],
      adapter: {
        project: ({
          state,
          patch,
        }) => [
          ...state,
          patch,
        ],
        represented: ({
          state,
          intent,
        }) => state.some(entry =>
          entry.id === intent.id || entry.replyId === intent.id || entry.messageId === intent.id),
      },
    })
    const pending = stored<{
      id: string
      text: string
      error?: string
    }[]>({
      key: `${key}:pending`,
      fallback: [],
    })

    for (const message of pending) {
      created.enqueue({
        id: message.id,
        targets: [card.id],
        delivery: 'idempotent',
        patch: {
          id: message.id,
          replyId: message.id,
          role: 'user',
          kind: 'message',
          text: message.text,
          sending: true,
        },
      })
      const error = new CommandFailure({
        message: message.error ?? 'Checking…',
        code: 'RESTORED',
        outcome: message.error ? 'refused' : 'unknown',
      })

      if (message.error) {
        created.refuse({
          id: message.id,
          error,
        })
      } else {
        created.unknown({
          id: message.id,
          error,
        })
      }
    }

    created.subscribe(() => saveLocal({
      key: `${key}:pending`,
      value: created.snapshot().intents
        .filter(intent => intent.stage !== 'confirmed')
        .map(intent => ({
          id: intent.id,
          text: intent.patch.text,
          error: intent.stage === 'refused' ? intent.error?.message : undefined,
        })),
    }))
    replies.set(
      key,
      created,
    )

    return created
  })
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  const [
    error,
    setError,
  ] = useState('')
  const drafts = useChatDrafts({
    text: stored({
      key: `${key}:draft`,
      fallback: '',
    }),
    commentsKey: `${key}:comments`,
    saveText: ({ text }) => saveLocal({
      key: `${key}:draft`,
      value: text,
    }),
  })
  const draft = useDraftSnapshot({ drafts })
  useEffect(
    () => {
      if (live) {
        resource.confirm({ state: live.conversation?.entries ?? live.entries })
      }
    },
    [
      live,
      resource,
    ],
  )
  useEffect(
    () => {
      if (!connected) {
        return
      }

      let cancelled = false
      command({
        name: 'thread',
        args: [card.id],
      }).then(() => {
        if (!cancelled) {
          setError('')
        }
      })
        .catch((error: Error) => {
          if (!cancelled) {
            setError(error.message)
          }
        })

      return () => {
        cancelled = true
      }
    },
    [
      card.id,
      command,
      connected,
    ],
  )
  const lookup = useMemo(
    () => pnyxLookup({ state: () => state }),
    [state],
  )
  const failed = snapshot.intents.filter(intent => intent.stage === 'refused')
    .map(intent => ({
      ...intent.patch,
      sending: false,
      unsent: intent.error?.message,
    }))
  const entries = [
    ...snapshot.view.map(entry => {
      const intent = snapshot.intents.find(intent => intent.id === entry.id)

      return {
        ...entry,
        checking: intent?.stage === 'unknown',
        sending: !!intent && intent.stage !== 'confirmed',
      }
    }),
    ...failed,
  ].map(entry => ({
    ...entry,
    renderKey: `${entry.replyId ?? entry.messageId ?? entry.id}:${entry.part ?? 0}`,
  }))

  const send = async ({
    id,
    text,
  }: {
    id: string
    text: string
  }) => {
    const existing = resource.snapshot().intents.find(intent => intent.id === id)

    if (existing) {
      resource.retry({ id })
    } else {
      resource.enqueue({
        id,
        targets: [card.id],
        delivery: 'idempotent',
        patch: {
          id,
          replyId: id,
          role: 'user',
          kind: 'message',
          text,
          at: new Date().toISOString(),
          sending: true,
        },
      })
    }

    try {
      resource.sending({ id })
      await command({
        name: 'reply',
        args: [
          card.id,
          text,
          id,
        ],
        onChecking: () => resource.unknown({
          id,
          error: new CommandFailure({
            message: 'Checking…',
            code: 'CHECKING',
            outcome: 'unknown',
          }),
        }),
      })
      resource.accept({ id })
      setError('')
    } catch (error) {
      const failure = error instanceof CommandFailure ? error : new CommandFailure({
        message: String(error),
        code: 'FAILED',
      })

      if (failure.outcome === 'unknown') {
        resource.unknown({
          id,
          error: failure,
        })
      } else {
        resource.refuse({
          id,
          error: failure,
        })
      }
    }
  }

  useEffect(
    () => {
      if (!connected) {
        return
      }

      for (const intent of resource.snapshot().intents) {
        if (intent.stage === 'unknown') {
          send({
            id: intent.id,
            text: intent.patch.text,
          })
        }
      }
    },
    [
      connected,
      resource,
    ],
  )

  return (
    <section className="worker-chat flex min-h-0 min-w-0 flex-col border-l border-line pl-3 [&>.composer]:mt-2 [&>.composer]:shrink-0" aria-label={`Worker chat for ${card.title}`} data-key-scope="thread">
      <div className="worker-messages min-h-0 flex-1 overflow-auto text-chat">
        {error && <p role="alert">{error}</p>}
        {live?.unavailable && card.agent && <Tooltip content={live.unavailable}><span aria-label="Conversation unavailable"><Icon name="warning" /></span></Tooltip>}
        <Messages
          entries={entries}
          lookup={lookup}
          drafts={drafts}
          comments={draft.comments}
          quote={({ text }) => drafts.setDraft({ text: `${draft.text}\n${text}` })}
          timings={new Map(Object.entries(live?.conversation?.timings ?? {}))}
          folds={new Map(Object.entries(live?.conversation?.folds ?? {}))}
          assistantLabel="Worker"
          notify={notify}
          retry={({ id }) => {
            const intent = resource.snapshot().intents.find(intent => intent.id === id)

            if (intent) {
              send({
                id,
                text: intent.patch.text,
              })
            }
          }}
        />
      </div>
      <Composer
        hydraId={hydraId}
        storageIdentity={storageIdentity}
        card={card.id}
        title={card.title}
        drafts={drafts}
        thread={live ?? null}
        fieldLabel="Message worker"
        placeholder="Message worker…"
        sendLabel="Send to worker"
        unavailable={!connected}
        loadComment={async () => {
          await command({
            name: 'thread',
            args: [card.id],
          })
        }}
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

          await send({
            id: args[2]!,
            text: args[1]!,
          })

          return {}
        }}
        notify={notify}
      />
    </section>
  )
}
