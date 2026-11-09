import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { HydraChatQueue } from '#hydra/chat-queue.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { VIEW_SIZE_LIMITS } from '#preferences/view.ts'
import type { Command } from '#web-app/connection.ts'
import { Button,InlineButton } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Resize } from '#web-shared/ui/resize.tsx'
import { InlineQuestions } from '#web-tasks/questions.tsx'
import { AnsweredQuestions } from '#web-tasks/answered-questions.tsx'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { WaitingDecisions } from '#web-tasks/waiting-decisions.tsx'
import { UpgradeRow } from '#web-upgrade/upgrade-row.tsx'
import { CompactionQueue,CompactionRow } from '#web-workers/compaction.tsx'
import { DispatchProposals } from '#web-workers/dispatch-proposals.tsx'
import { InlinePermissions } from '#web-workers/permissions.tsx'
import { UsageRing } from '#web-workers/usage-ring.tsx'
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from 'react'
import { ActionBubble } from './action-bubble.tsx'
import { AgentChangeChoice } from './agent-change-choice.tsx'
import { ChatDecisionCard } from './chat-decisions.tsx'
import { chatDecisions, type ChatDecision } from './chat-questions.ts'
import { hydraPill,keepStreamedKeys,quoteInto,type ChatComment } from './chat.ts'
import { MESSAGE_SCROLL } from './comment-motion.ts'
import { useComposerSources } from './composer-sources.tsx'
import { Composer } from './composer.tsx'
import { loadEarlierMessages,receivedThread } from './conversation-history.ts'
import { HydraAgent } from './hydra-agent.tsx'
import { HydraHead } from './hydra-head.tsx'
import { type HydraIdentity } from './hydra-title.tsx'
import { Messages,type ChatEntry } from './messages.tsx'
import { pnyxLookup } from './pnyx-action.ts'
import { Running } from './running-indicator.tsx'
import { REDUCED_MOTION } from './streaming.tsx'

// How long after the owner's own input a scroll up still counts as theirs.
const OWNER_SCROLL_MS = 1000
// The share of the distance to the bottom that following covers per frame.
const GLIDE = 0.3

// What the chat shows until the server's first queue arrives.
const EMPTY_CHAT_QUEUE: HydraChatQueue = {
  compacting: undefined,
  upgrades: [],
  held: [],
  compactOperations: [],
  shownUpgrades: [],
  upgrading: false,
  holding: false,
  runningChange: false,
  compactionRunning: false,
  upgradeRunning: false,
  compactInputs: [],
  hosted: false,
  working: false,
  through: 0,
}

// Sends the server has not recorded yet; a confirmed one waits for its message to arrive.
interface Sending {
  id: string
  text: string
  at: string
  confirmed: boolean
}

export function HydraChat({
  hydraId,
  state,
  command,
  connected,
  notify,
  view,
  save,
  draft,
  setDraft,
  comments,
  setComments,
  liveThread,
  queue,
  identity,
  editHydra,
  addProject,
  projectRequest,
  projectRequested,
  openTask,
  action,
  taskActions,
  selectedTask,
}: {
  hydraId: string
  // The Hydra's name and icon for the header, and the names of the owner's other Hydras.
  identity?: {
    name: string
    icon?: string
    taken: string[]
  }
  editHydra?({
    name,
    icon,
  }: HydraIdentity): void
  addProject?(): void
  projectRequest?: boolean
  projectRequested?(): void
  action?: CurrentAction
  selectedTask?: string | null
  taskActions?: Record<string, CurrentAction>
  liveThread: ThreadPage | null
  queue: HydraQueue
  state: HydraState
  command: Command
  connected: boolean
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
}) {
  const waitingButton = useRef<HTMLButtonElement>(null)

  useEffect(
    () => {
      if (new URLSearchParams(location.search).has('new-chat')) {
        stream.current?.parentElement?.parentElement?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
        const url = new URL(location.href)
        url.searchParams.delete('new-chat'); history.replaceState(
          null,
          '',
          url,
        )
      }
    },
    [],
  )
  const [
    page,
    setPage,
  ] = useState<ThreadPage | null>(liveThread)
  const [
    width,
    setWidth,
  ] = useState<number | null>(null)
  const [
    sending,
    setSending,
  ] = useState<Sending[]>([])
  const [
    away,
    setAway,
  ] = useState(false)
  const stream = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const follow = useRef(true), lastTop = useRef(0), scrolledAt = useRef(0), glide = useRef(0)
  const previousEntries = useRef<ChatEntry[]>([]), streamedKeys = useRef(new Map<string, string>())
  const config = hydraConfig({ state }), hydra = config.hydra, card = state.cards[HYDRA_CARD]
  const offerProject = !!addProject && hydra.kind !== 'firstmate' && !(state.projects ?? []).some(p => !p.detached)
  const { catalog } = useComposerSources()
  const retainedPage = useRef(page)
  useLayoutEffect(
    () => {
      retainedPage.current = page
    },
    [page],
  )
  useEffect(
    () => {
      if (!connected || !card) {
        return
      }

      let cancelled = false
      const args = [HYDRA_CARD]
      const retained = retainedPage.current

      if (retained?.entries.length) {
        args.push(
          '--retain',
          JSON.stringify({
            session: retained.session,
            oldest: retained.entries[0]!.id,
          }),
        )
      }

      void command({
        name: 'thread',
        args,
      }).then(result => {
        if (!cancelled) {
          setPage(before => receivedThread({
            before,
            latest: result.thread as ThreadPage,
          }))
        }
      })
        .catch(() => {
          if (!cancelled) {
            notify({ text: 'Could not load the conversation. Reconnect to try again.' })
          }
        })

      return () => {
        cancelled = true
      }
    },
    [
      connected,
      command,
      card?.agent?.sessionId,
      !!card,
    ],
  )
  useEffect(
    () => {
      if (liveThread) {
        setPage(before => receivedThread({
          before,
          latest: liveThread,
        }))
      }
    },
    [liveThread],
  )
  const chatQueue = queue.chat ?? EMPTY_CHAT_QUEUE
  const held = new Set(chatQueue.held)
  const pending = sending.filter(item => {
    const deliveredAt = state.eventIds[item.id]
    const recorded = deliveredAt !== undefined
    const rendered = (deliveredAt ?? 0) <= (page?.conversation?.through ?? 0)

    return !recorded || !rendered
  })
  const {
    compacting,
    upgrades,
    compactOperations,
    shownUpgrades,
    upgrading,
    holding,
    runningChange,
    compactionRunning,
    upgradeRunning,
    working,
    hosted,
  } = chatQueue
  const compactInputs = [
    ...chatQueue.compactInputs,
    ...pending.filter(item => holding && !held.has(item.id)).map(item => ({
      ...item,
      actor: 'web',
      route: 'hydra' as const,
    })),
  ]

  // Stops Hydra's turn, its compaction or the upgrade running in their place.
  const stop = async () => {
    try {
      await command({
        name: 'hydra',
        args: ['stop'],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  useEffect(
    () => {
      if (pending.length < sending.length) {
        setSending(pending)
      }
    },
    [
      pending.length,
      sending.length,
    ],
  )
  const [
    loadingEarlier,
    setLoadingEarlier,
  ] = useState(false)
  const olderCursor = page?.older
  const conversation = page?.conversation
  const chat = {
    entries: conversation?.entries ?? [],
    folds: new Map(Object.entries(conversation?.folds ?? {})),
    timings: new Map(Object.entries(conversation?.timings ?? {})),
    trailing: new Map(Object.entries(conversation?.trailing ?? {})),
  }
  const decisions = chatDecisions({
    state,
    selectedTask,
    draft,
  })
  const shownDecisions = decisions
  const inline = new Map(shownDecisions.map(decision => [
    decision.id,
    <ChatDecisionCard
      key={decision.id}
      decision={decision}
      command={command}
      notify={notify}
    />,
  ]))

  for (const operation of compactOperations) {
    inline.set(
      `compact:${operation.id}`,
      <CompactionRow key={operation.id} operation={operation} />,
    )
  }

  for (const operation of shownUpgrades) {
    inline.set(
      `upgrade:${operation.id}`,
      <UpgradeRow
        key={operation.id}
        operation={operation}
        askHydra={setDraft}
        stop={stop}
        restartNow={async () => {
          try {
            await command({
              name: 'compact',
              args: [
                HYDRA_CARD,
                operation.id,
              ],
            })
          } catch (error) {
            notify({ text: (error as Error).message })
          }
        }}
      />,
    )
  }

  const listed: ChatEntry[] = [
    ...compactOperations.map(operation => ({
      id: `compact:${operation.id}`,
      kind: 'message' as const,
      role: 'Pnyx',
      text: '',
      at: operation.startedAt,
    })),
    ...shownUpgrades.map(operation => ({
      id: `upgrade:${operation.id}`,
      kind: 'message' as const,
      role: 'Pnyx',
      text: '',
      at: operation.startedAt ?? operation.queuedAt,
    })),
    ...chat.entries,
    ...shownDecisions.map(decision => ({
      id: decision.id,
      kind: 'message' as const,
      role: 'Hydra question',
      task: decision.card.id,
      text: '',
      at: decision.at,
    })),
    ...pending.filter(s => !holding && !held.has(s.id)).map(s => ({
      id: s.id,
      kind: 'message' as const,
      role: 'user',
      text: s.text,
      at: s.at,
      sending: !s.confirmed,
    })),
  ].sort((
    a,
    b,
  ) => (a.at ?? '').localeCompare(b.at ?? ''))
  const entries = keepStreamedKeys({
    entries: listed,
    previous: previousEntries.current,
    keys: streamedKeys.current,
  })
  previousEntries.current = entries

  const threadSession = useRef(card?.agent?.sessionId)
  useLayoutEffect(
    () => {
      threadSession.current = card?.agent?.sessionId
    },
    [card?.agent?.sessionId],
  )

  const loadEarlier = async ({ until }: { until?: string }) => {
    const session = threadSession.current
    const earlier = await loadEarlierMessages({
      past: page,
      cursor: olderCursor,
      until,
      load: async ({ before }) => {
        const result = await command({
          name: 'thread',
          args: [
            HYDRA_CARD,
            before,
          ],
        })

        return result.thread as ThreadPage
      },
    })

    if (threadSession.current === session) {
      if (earlier) {
        setPage(before => receivedThread({
          before,
          latest: earlier,
        }))
      }
    }
  }

  const jumpDecision = async ({ decision }: { decision: ChatDecision }) => {
    // The owner asked for this scroll: a glide still easing a reply to the bottom must not undo it.
    ownerScroll()
    follow.current = false
    setAway(true)
    setLoadingEarlier(true)

    try {
      const selector = `[data-entry-id="${CSS.escape(decision.id)}"]`
      const target = () => stream.current?.querySelector<HTMLElement>(selector)

      if (!target()) {
        await loadEarlier({ until: decision.at })
      }

      requestAnimationFrame(() => {
        const question = target()
        question?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
        question?.querySelector<HTMLElement>('.ask button:not(:disabled), .ask textarea')?.focus()
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setLoadingEarlier(false)
    }
  }

  // The dots start with the send and stay on until the turn ends, through streaming and tool calls.
  const running = working || (hosted && pending.length > 0)
  // A send counts from the owner's message until the server says the turn began.
  const lookup = pnyxLookup({ state })
  const since = (working ? card?.workingSince : undefined)
    ?? pending.at(-1)?.at ?? null

  const bottom = () => {
    const element = stream.current

    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }

  // Following eases toward the bottom; any input of the owner's stops it at once.
  const settle = () => {
    const element = stream.current
    glide.current = 0

    if (!element || !follow.current) {
      return
    }

    const left = element.scrollHeight - element.clientHeight - element.scrollTop

    if (left >= 1) {
      element.scrollTop += Math.ceil(left * GLIDE)
      glide.current = requestAnimationFrame(settle)
    }
  }

  const ownerScroll = () => {
    scrolledAt.current = performance.now()
    cancelAnimationFrame(glide.current)
    glide.current = 0
  }

  useLayoutEffect(
    () => {
      const element = content.current

      if (!element || !stream.current) {
        return
      }

      const scroller = stream.current
      const observer = new ResizeObserver(() => {
        // One side of the stream's scrollbar gutter (0 with overlay scrollbars), for --chat-inset in index.css.
        scroller.closest<HTMLElement>('.hydra-chat')?.style.setProperty(
          '--chat-scrollbar',
          `${(scroller.offsetWidth - scroller.clientWidth) / 2}px`,
        )

        if (!follow.current || glide.current) {
          return
        }

        const left = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop

        // A page load or a jump of more than a screen snaps; only a growing reply glides.
        if (left > scroller.clientHeight || matchMedia(REDUCED_MOTION).matches) {
          bottom()
        } else {
          glide.current = requestAnimationFrame(settle)
        }
      })
      observer.observe(element)
      observer.observe(scroller)
      scroller.addEventListener(
        MESSAGE_SCROLL,
        ownerScroll,
      )

      return () => {
        observer.disconnect()
        cancelAnimationFrame(glide.current)
        scroller.removeEventListener(
          MESSAGE_SCROLL,
          ownerScroll,
        )
      }
    },
    [],
  )

  const sendAgain = async ({
    task,
    text,
  }: {
    task: string
    text: string
  }) => {
    try {
      await command({
        name: 'reply',
        args: [
          task,
          text,
          crypto.randomUUID(),
        ],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const deliver = useCallback<Command>(
    async ({
      name,
      args,
      onChecking,
    }) => {
      if (name !== 'reply') {
        return command({
          name,
          args,
        })
      }

      const id = args[2] ?? crypto.randomUUID()
      follow.current = true; setAway(false)
      setSending(items => items.some(s => s.id === id) ? items : [
        ...items,
        {
          id,
          text: args[1] ?? '',
          at: new Date().toISOString(),
          confirmed: false,
        },
      ])
      requestAnimationFrame(bottom)

      const result = await command({
        name: 'hydra',
        args: [
          'send',
          `--text=${args[1] ?? ''}`,
          '--event-id',
          id,
        ],
        onChecking,
      }).catch((error: Error) => {
        setSending(items => items.filter(s => s.id !== id))
        throw error
      })

      const queued = result.state === 'queued'
      setSending(items => queued ? items.map(s => s.id === id ? {
        ...s,
        confirmed: true,
      } : s) : items.filter(s => s.id !== id))

      return {
        reply: {
          state: queued ? 'queued' : 'failed',
          detail: result.detail,
        },
      }
    },
    [command],
  )
  const route: ThreadPage = {
    ...page,
    card: HYDRA_CARD,
    entries,
    route: true,
    watching: 'unknown',
  }
  const references = useTaskReferences({
    state,
    actions: taskActions,
    connected,
  })
  const canStop = runningChange || ((working || compacting) && card?.agent?.host === 'pnyx') || upgradeRunning
  const errors = card?.attention.filter(a => a.key === 'pnyx:interrupted' || a.kind === 'interrupted') ?? []
  // Hydra's own state, apart from the browser's connection that the offline badge shows.
  const pill = hydraPill({
    status: state.hydraStatus,
    upgrading,
    working,
    starting: pending.length > 0,
  })

  return (
    <aside
      className="hydra-chat"
      aria-label="Hydra’s chat"
      style={{
        width: width ?? view.hydraWidth,
        flexBasis: width ?? view.hydraWidth,
      }}
    >
      <HydraHead
        name={identity?.name ?? config.name}
        icon={identity?.icon}
        taken={identity?.taken ?? []}
        editHydra={editHydra}
        addProject={addProject}
        connected={connected}
      >
        {hosted && <span className="hydra-status" role="status" data-down={pill.down || undefined}>{pill.text}</span>}
      </HydraHead>
      <div className="hydra-body">
        <div
          className="hydra-messages thread"
          ref={stream}
          data-key-scope="thread"
          role="region"
          aria-label="Hydra conversation"
          data-away={away || undefined}
          tabIndex={0}
          onWheel={ownerScroll}
          onTouchMove={ownerScroll}
          onKeyDown={event => {
            ownerScroll()

            if (event.target instanceof Element && event.target.closest('summary')) {
              follow.current = false
            }
          }}
          onPointerDown={event => {
            if (event.target instanceof Element && event.target.closest('summary')) {
              follow.current = false
              ownerScroll()
            }

            if (event.target === event.currentTarget) {
              ownerScroll()
            }
          }}
          onPointerMove={event => {
            if (event.buttons) {
              ownerScroll()
            }
          }}
          onScroll={e => {
            const el = e.currentTarget

            // Any way to the bottom pins; only the owner's own upward scroll unpins, never one the browser makes.
            const owner = performance.now() - scrolledAt.current < OWNER_SCROLL_MS

            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              follow.current = true
            } else if (owner && el.scrollTop < lastTop.current) {
              follow.current = false
            }

            lastTop.current = el.scrollTop
            setAway(!follow.current)
          }}
        >
          <div className="hydra-stream" ref={content}>
            {olderCursor && (
              <Button
                disabled={loadingEarlier || !connected}
                onClick={async () => {
                  setLoadingEarlier(true)

                  try {
                    await loadEarlier({})
                  } catch (error) {
                    notify({ text: (error as Error).message })
                  } finally {
                    setLoadingEarlier(false)
                  }
                }}
              >Older messages
              </Button>
            )}
            <Messages
              catalog={catalog}
              labelColors={state.labelColors}
              folds={chat.folds}
              trailing={chat.trailing}
              timings={chat.timings}
              inline={inline}
              entries={entries}
              lookup={lookup}
              assistantLabel="Hydra"
              notify={notify}
              openTask={openTask}
              taskReferences={references}
              comments={comments}
              setComments={setComments}
              quote={({ text }) => setDraft({
                text: quoteInto({
                  draft,
                  text,
                }),
              })}
              toolDetails={view.toolDetails}
              thinkingDetails={view.thinkingDetails}
              sendAgain={sendAgain}
            />
            <DispatchProposals
              state={state}
              command={command}
              connected={connected}
              notify={notify}
            />
            {!entries.length && (
              <p className="hydra-empty">
                What are we working on?
                {offerProject && <> <InlineButton className="hydra-empty-action" onClick={addProject}>Add a project</InlineButton></>}
              </p>
            )}
            {errors.map(a => <p key={a.key} className="chat-error" role="alert"><Icon name="error" size={16} />{a.text}</p>)}
            {card && <AnsweredQuestions card={card} command={command} notify={notify} />}
            {card && (
              <InlinePermissions
                card={{
                  ...card,
                  permissions: card.permissions?.filter(p => p.status === 'pending' || p.delivery === 'needs_reentry' || p.delivery === 'unknown'),
                }}
                command={command}
                notify={notify}
              />
            )}
            {card && (
              <InlineQuestions
                card={card}
                command={command}
                notify={notify}
              />
            )}
          </div>
        </div>
        {running && !compacting && (
          <TaskReferencesProvider references={references} openTask={openTask}>
            <Running
              since={running ? since : null}
              running={running}
              label={card?.agent ? 'Hydra is working' : 'Starting Hydra'}
              reading={queue.reading}
              waiting={queue.waiting}
              state={state}
            >
              {running && <ActionBubble action={action} since={since} lookup={lookup} />}
            </Running>
          </TaskReferencesProvider>
        )}
        {away && (
          <>
            <div className="chat-fade" aria-hidden="true" />
            <Button
              className="jump"
              aria-label="Jump to latest"
              title="Jump to latest"
              onClick={() => {
                follow.current = true; setAway(false)
                stream.current?.scrollTo({
                  top: stream.current.scrollHeight,
                  behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                })
              }}
            >
              <Icon name="chevron_down" size={18} />
            </Button>
          </>
        )}
      </div>
      <WaitingDecisions
        triggerRef={waitingButton}
        state={state}
        open={async ({ decision }) => {
          const question = decisions.find(item =>
            item.card.id === decision.card.id && item.ask.id === decision.id)

          if (decision.card.id === HYDRA_CARD && question) {
            await jumpDecision({ decision: question })
          } else {
            openTask({ id: decision.card.id })
          }
        }}
        loading={loadingEarlier}
      />
      <AgentChangeChoice
        state={state}
        command={command}
        connected={connected}
        notify={notify}
      />
      <CompactionQueue
        inputs={compactInputs}
        disabled={!connected || (!compacting && !upgrades.some(operation => operation.state === 'queued'))}
        sendNow={async ({ id }) => {
          try {
            await command({
              name: 'compact',
              args: [
                HYDRA_CARD,
                id,
              ],
            })
          } catch (error) {
            notify({ text: (error as Error).message })
          }
        }}
      />
      <Composer
        hydraId={hydraId}
        compacting={compactionRunning}
        focusAbove={() => {
          if (!waitingButton.current || waitingButton.current.disabled) {
            return false
          }

          waitingButton.current.focus()

          return true
        }}
        card={HYDRA_CARD}
        title="Hydra"
        draft={draft}
        setDraft={setDraft}
        comments={comments}
        setComments={setComments}
        thread={route}
        command={deliver}
        notify={notify}
        projectRequest={projectRequest}
        projectRequested={projectRequested}
        stop={canStop ? stop : undefined}
        meter={<UsageRing card={card} command={command} connected={connected} />}
        settings={(
          <HydraAgent
            state={state}
            command={command}
            connected={connected}
            notify={notify}
          />
        )}
      />
      <Resize
        label="Resize Hydra panel"
        value={view.hydraWidth}
        min={VIEW_SIZE_LIMITS.hydraWidth.min}
        onPreview={({ value }) => setWidth(value)}
        onCommit={({ value }) => save({ patch: { hydraWidth: value } }).then(saved => {
          setWidth(null)

          return saved
        })}
      />
    </aside>
  )
}
