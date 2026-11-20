import type { AgentConfig } from '#workers/model.ts'
import { queuedAgentLabel } from '#workers/providers.ts'
import { useCardAgent, cardSendArgs, RepositoryPicker } from '#web-workers/card-agent.tsx'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { traces } from '#preferences/view.ts'
import { stored, save as saveLocal } from '#web-app/connection-storage.ts'
import type { Command } from '#web-app/connection.ts'
import { Messages, type ChatEntry } from '#web-hydra/messages.tsx'
import { ActionBubble } from '#web-hydra/action-bubble.tsx'
import { useChatScroll } from '#web-hydra/chat-scroll.ts'
import { CHAT_FRAME, Chat } from '#web-hydra/chat-view.tsx'
import { useComposerSources } from '#web-hydra/composer-sources.tsx'
import { useChatThread } from '#web-hydra/chat-thread.ts'
import { Running } from '#web-hydra/running-indicator.tsx'
import { Composer } from '#web-hydra/composer.tsx'
import { useChatDrafts, useDraftSnapshot } from '#web-hydra/chat-drafts.ts'
import { pnyxLookup } from '#web-hydra/pnyx-action.ts'
import { quoteInto } from '#web-hydra/chat.ts'
import { Icon } from '#web-shared/icons.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { CommandFailure, createPendingResource } from '#web-shared/pending-intents.ts'

type WorkerMessage = ChatEntry & { targetAgent?: AgentConfig }

type ReplyResource = ReturnType<typeof createPendingResource<WorkerMessage[], WorkerMessage>>
const replies = new Map<string, ReplyResource>()
const NO_WAKE_QUEUE: [] = []

export function TaskChat({
  hydraId,
  storageIdentity,
  card,
  state,
  live,
  action,
  view,
  command,
  connected,
  notify,
}: {
  hydraId: string
  storageIdentity: string
  card: Card
  state: HydraState
  live: ThreadPage | null | undefined
  action?: CurrentAction
  view: ViewPreferences
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
}) {
  const scroll = useChatScroll()
  const { catalog } = useComposerSources()
  const {
    agent,
    settings,
    outside,
  } = useCardAgent({
    identity: card.key,
    card,
    command,
    connected,
  })
  const project = state.projects?.find(project => !project.detached
    && (project.path === card.project || project.name === card.project))
  const [
    chosenRepository,
    chooseRepository,
  ] = useState('')
  const [
    assigning,
    setAssigning,
  ] = useState(false)
  const showRepository = !outside && !project
  const needsRepository = showRepository && !card.agent
  const repositories = (state.projects ?? []).filter(project => !project.detached)
    .map(project => ({
      value: project.path,
      label: project.name,
    }))

  const installation = document.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content
  const key = `${location.origin}:${installation}:${hydraId}:${card.id}`
  const [resource] = useState(() => {
    const existing = replies.get(key)

    if (existing) {
      return existing
    }

    const created = createPendingResource<WorkerMessage[], WorkerMessage>({
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
      targetAgent?: AgentConfig
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
          targetAgent: message.targetAgent,
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
          targetAgent: intent.patch.targetAgent,
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
  const drafts = useChatDrafts({
    identity: `${location.origin}:${installation}:${hydraId}:${card.key}`,
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
  const thread = useChatThread({
    card: card.id,
    session: card.agent?.sessionId,
    page: live,
    command,
    connected,
    scroll,
  })
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
        waiting: intent?.patch.targetAgent
          ? queuedAgentLabel({ agent: intent.patch.targetAgent }) : entry.waiting,
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
    targetAgent = agent,
  }: {
    id: string
    text: string
    targetAgent?: AgentConfig
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
          receipt: 'queued',
          targetAgent,
          at: new Date().toISOString(),
          sending: true,
        },
      })
    }

    try {
      resource.sending({ id })
      await command({
        name: outside ? 'reply' : 'task',
        args: outside ? [
          card.id,
          text,
          id,
        ] : cardSendArgs({
          card: card.id,
          text,
          id,
          agent: targetAgent,
        }),
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
            targetAgent: intent.patch.targetAgent,
          })
        }
      }
    },
    [
      connected,
      resource,
    ],
  )

  const working = (card.sessionActivity ?? card.activity) === 'working'
  const showsTools = traces({
    view,
    card: card.id,
  }).tools
  const since = card.workingSince ?? null
  const statusLine = working ? (
    <Running
      since={since}
      running
      label="Worker is working"
      reading={NO_WAKE_QUEUE}
      waiting={NO_WAKE_QUEUE}
      state={state}
    >
      {showsTools && <ActionBubble action={action} since={since} lookup={lookup} />}
    </Running>
  ) : null

  return (
    <section className={`task-chat flex min-h-0 min-w-0 flex-col border-l border-line ${CHAT_FRAME}`} aria-label={`Worker chat for ${card.title}`}>
      <Chat
        title={card.title}
        scroll={scroll}
        older={thread.older}
        loadingEarlier={thread.loadingEarlier}
        error={thread.error}
        status={statusLine}
      >
        {live?.unavailable && card.agent && <Tooltip content={live.unavailable}><span aria-label="Conversation unavailable"><Icon name="warning" /></span></Tooltip>}
        <Messages
          catalog={catalog}
          labelColors={state.labelColors}
          entries={entries}
          lookup={lookup}
          drafts={drafts}
          comments={draft.comments}
          quote={({ text }) => drafts.setDraft({
            text: quoteInto({
              draft: drafts.read().text,
              text,
            }),
          })}
          timings={new Map(Object.entries(live?.conversation?.timings ?? {}))}
          folds={new Map(Object.entries(live?.conversation?.folds ?? {}))}
          trailing={new Map(Object.entries(live?.conversation?.trailing ?? {}))}
          toolDetails={view.toolDetails}
          thinkingDetails={view.thinkingDetails}
          assistantLabel="Worker"
          notify={notify}
          retry={({ id }) => {
            scroll.toEnd()
            const intent = resource.snapshot().intents.find(intent => intent.id === id)

            if (intent) {
              send({
                id,
                text: intent.patch.text,
                targetAgent: intent.patch.targetAgent,
              })
            } else {
              const entry = entries.find(entry => entry.id === id)
              const reply = card.replies?.find(reply => reply.id === entry?.replyId)

              if (reply?.worker && reply.text) {
                send({
                  id: reply.id,
                  text: reply.text,
                  targetAgent: reply.worker.agent,
                })
              }
            }
          }}
        />
      </Chat>
      {showRepository && (
        <div className="mx-(--chat-inset)">
          <RepositoryPicker
            value={chosenRepository}
            repositories={repositories}
            disabled={!connected || assigning || card.createdSeq === 0}
            change={async ({ value }) => {
              chooseRepository(value)
              setAssigning(true)

              try {
                await command({
                  name: 'task',
                  args: [
                    'project',
                    card.id,
                    '--project',
                    value,
                    '--event-id',
                    crypto.randomUUID(),
                  ],
                })
              } catch (error) {
                chooseRepository('')
                notify({ text: error instanceof Error ? error.message : String(error) })
              } finally {
                setAssigning(false)
              }
            }}
          />
        </div>
      )}
      <Composer
        hydraId={hydraId}
        storageIdentity={storageIdentity}
        card={card.id}
        title={card.title}
        drafts={drafts}
        thread={live ?? null}
        settings={settings}
        stop={card.agent?.host === 'pnyx' && working ? async () => {
          await command({
            name: 'task',
            args: [
              'stop',
              card.id,
            ],
          })
        } : undefined}
        stopLabel="Stop worker"
        stopTitle="Stop worker’s turn"
        fieldLabel="Message worker"
        placeholder="Message worker…"
        sendLabel="Send to worker"
        unavailable={!connected || assigning || needsRepository || card.createdSeq === 0}
        loadComment={thread.loadComment}
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

          scroll.toEnd()
          await send({
            id: args[2] ?? crypto.randomUUID(),
            text: args[1] ?? '',
          })

          return {}
        }}
        notify={notify}
      />
    </section>
  )
}
