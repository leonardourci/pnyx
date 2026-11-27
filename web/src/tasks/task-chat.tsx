import { joinMessageParts } from '#titan/history.ts'
import { statusLabel } from '#tasks/card-status.ts'
import { observedStatus } from './observed-status.ts'
import type { PendingTurn } from '#web-workers/pending-turns.ts'
import type { AgentConfig } from '#workers/model.ts'
import { queuedAgentLabel } from '#workers/providers.ts'
import { useCardAgent, RepositoryPicker } from '#web-workers/card-agent.tsx'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { TitanState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { ThreadPage } from '#titan/transcripts-read.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { traces } from '#preferences/view.ts'
import { stored, save as saveLocal } from '#web-app/connection-storage.ts'
import type { Command } from '#web-app/connection.ts'
import { sendChatMessage } from '#web-titan/chat-send.ts'
import { Messages, type ChatEntry } from '#web-titan/messages.tsx'
import { ActionBubble } from '#web-titan/action-bubble.tsx'
import { useChatScroll } from '#web-titan/chat-scroll.ts'
import { CHAT_FRAME, Chat } from '#web-titan/chat-view.tsx'
import { useComposerSources } from '#web-titan/composer-sources.tsx'
import { useChatThread } from '#web-titan/chat-thread.ts'
import { Running } from '#web-titan/running-indicator.tsx'
import { Composer } from '#web-titan/composer.tsx'
import { useChatDrafts, useDraftSnapshot } from '#web-titan/chat-drafts.ts'
import { othrysLookup } from '#web-titan/othrys-action.ts'
import { quoteInto } from '#web-titan/chat.ts'
import { Icon } from '#web-shared/icons.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { CommandFailure, createPendingResource } from '#web-shared/pending-intents.ts'

type WorkerMessage = ChatEntry & { targetAgent?: AgentConfig }

type ReplyResource = ReturnType<typeof createPendingResource<WorkerMessage[], WorkerMessage>>
const replies = new Map<string, ReplyResource>()
const NO_WAKE_QUEUE: [] = []

export function TaskChat({
  titanId,
  storageIdentity,
  card,
  state,
  live,
  action,
  view,
  command,
  connected,
  notify,
  pendingTurn,
}: {
  titanId: string
  storageIdentity: string
  card: Card
  state: TitanState
  live: ThreadPage | null | undefined
  action?: CurrentAction
  pendingTurn?: PendingTurn
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
  const repositories = (state.projects ?? []).filter(project => !project.detached)
    .map(project => ({
      value: project.path,
      label: project.name,
    }))

  const installation = document.querySelector<HTMLMetaElement>('meta[name=othrys-installation]')?.content
  const key = `${location.origin}:${installation}:${titanId}:${card.id}`
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
    identity: `${location.origin}:${installation}:${titanId}:${card.key}`,
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
        resource.confirm({
          state: joinMessageParts({ entries: live.conversation?.entries ?? live.entries }),
        })
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
    () => othrysLookup({ state: () => state }),
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
        unsent: entry.receipt === 'failed' && entry.waiting !== 'stopped' ? entry.waiting : entry.unsent,
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

    if (existing && existing.stage !== 'confirmed') {
      resource.retry({ id })
    } else if (!existing) {
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
      await sendChatMessage({
        command,
        card: card.id,
        text,
        id,
        agent: targetAgent,
        outside,
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

  const liveStatus = observedStatus({
    card,
    state,
    action,
    pending: pendingTurn,
  })
  const working = liveStatus.kind === 'working'
  const nativeWorking = (card.sessionActivity ?? card.activity) === 'working'
  const showsTools = traces({
    view,
    card: card.id,
  }).tools
  const since = card.workingSince ?? null
  const status = statusLabel({
    status: liveStatus,
  })
  const statusLine = (
    <Running
      since={since}
      running={working}
      label={status}
      statusName="Worker status"
      reading={NO_WAKE_QUEUE}
      waiting={NO_WAKE_QUEUE}
      state={state}
    >
      {working && showsTools && <ActionBubble action={action} since={since} lookup={lookup} />}
    </Running>
  )

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
          retry={({
            id,
            replyId,
            text,
            targetAgent,
          }) => {
            scroll.toEnd()
            send({
              id: replyId ?? id,
              text,
              targetAgent,
            })
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
        titanId={titanId}
        storageIdentity={storageIdentity}
        card={card.id}
        title={card.title}
        drafts={drafts}
        thread={live ?? null}
        settings={settings}
        stop={card.agent?.host === 'othrys' && nativeWorking ? async () => {
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
        unavailable={!connected || assigning || card.createdSeq === 0}
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
