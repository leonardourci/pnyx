import { CommandFailure } from '#web-shared/pending-intents.ts'
import { useDraftSnapshot, type ChatDrafts } from './chat-drafts.ts'
import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { HydraChatQueue } from '#hydra/chat-queue.ts'
import { hostedHydra,hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { VIEW_SIZE_LIMITS } from '#preferences/view.ts'
import { knownCards } from '#tasks/select.ts'
import type { Command } from '#web-app/connection.ts'
import { firstTextShown, forgetSend, markSend } from '#web-app/log.ts'
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
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react'
import { flushSync } from 'react-dom'
import { ActionBubble } from './action-bubble.tsx'
import { AgentChangeChoice } from './agent-change-choice.tsx'
import { answerLeads } from './answer-leads.ts'
import { ChatDecisionCard } from './chat-decisions.tsx'
import { chatDecisions, type ChatDecision } from './chat-questions.ts'
import { hydraDown,keepStreamedKeys,quoteInto,withTimedRows,type ChatComment } from './chat.ts'
import { createChatFollow, watchHistoryFocus } from './chat-follow.ts'
import { MESSAGE_SCROLL, centerMessage } from './comment-motion.ts'
import { useComposerSources } from './composer-sources.tsx'
import { Composer } from './composer.tsx'
import { historyRead, loadEarlierMessages, receiveConversation, retainArgs, type HistoryMode } from './conversation-history.ts'
import { HydraAgent } from './hydra-agent.tsx'
import { HydraHead } from './hydra-head.tsx'
import { type HydraIdentity } from './hydra-title.tsx'
import { Messages,type ChatEntry } from './messages.tsx'
import { pnyxLookup } from './pnyx-action.ts'
import { readUnsent,saveUnsent } from './outbox.ts'
import { Running } from './running-indicator.tsx'
import { REDUCED_MOTION } from './streaming.tsx'

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
  working: false,
  through: 0,
  started: [],
}

// Sends the server has not recorded yet; a confirmed one waits for its message to arrive.
interface Sending {
  id: string
  text: string
  at: string
  confirmed: boolean
  // Why the send failed; the message stays, marked not sent, until a retry.
  failed?: string
}

const withFailure = ({
  items,
  id,
  failed,
}: {
  items: Sending[]
  id: string
  failed?: string
}) => items.map(item => item.id === id ? {
  ...item,
  failed,
} : item)

export function HydraChat({
  hydraId,
  state,
  command,
  connected,
  notify,
  view,
  save,
  drafts,
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
  drafts: ChatDrafts
}) {
  const {
    text: draft,
    comments,
  } = useDraftSnapshot({ drafts })
  const { setDraft } = drafts
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
  ] = useState<Sending[]>(() => readUnsent({ key: hydraId }).map(item => ({
    ...item,
    confirmed: false,
  })))
  const [
    away,
    setAway,
  ] = useState(false)
  const stream = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [chatFollow] = useState(() => createChatFollow({ changed: ({ away }) => setAway(away) }))
  const glide = useRef(0)
  const previousEntries = useRef<ChatEntry[]>([]), streamedKeys = useRef(new Map<string, string>())
  const streamingAtSend = useRef(new Set<string>())
  const lastSend = useRef<string>(undefined), sendTurnWorked = useRef(false)
  const config = hydraConfig({ state }), hydra = config.hydra, card = state.cards[HYDRA_CARD]
  const offerProject = !!addProject && hydra.kind !== 'firstmate' && !(state.projects ?? []).some(p => !p.detached)
  const { catalog } = useComposerSources()
  const selectionInHistory = useRef(false)
  const [
    selectedHistory,
    setSelectedHistory,
  ] = useState(false)
  useEffect(
    () => watchHistoryFocus({
      host: () => content.current?.querySelector('.messages'),
      changed: ({ selected }) => {
        selectionInHistory.current = selected
        setSelectedHistory(selected)
      },
    }),
    [],
  )
  // The owner is reading while the chat is away or the messages hold their focus or selection. Handlers read the
  // refs here; effects check the away and selectedHistory state instead, so they rerun when either changes.
  const readingNow = () => !chatFollow.following() || selectionInHistory.current
  const receivePage = ({
    before,
    latest,
  }: {
    before: ThreadPage | null
    latest: ThreadPage
  }) =>
    receiveConversation({
      before,
      latest,
      reading: readingNow(),
    })
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
      const retained = retainedPage.current
      const oldest = retained?.entries[0]
      const args = retained && oldest ? retainArgs({
        page: retained,
        oldest,
      }) : [HYDRA_CARD]

      void command({
        name: 'thread',
        args,
      }).then(result => {
        if (!cancelled) {
          setPage(before => receivePage({
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
        setPage(before => receivePage({
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
    return !page?.conversation?.entries.some(entry =>
      entry.reference === item.id || entry.id === item.id)
  })
  const {
    compacting,
    upgrades,
    compactOperations,
    shownUpgrades,
    holding,
    runningChange,
    compactionRunning,
    upgradeRunning,
    working,
  } = chatQueue
  // From the Hydra's own state, so a first send shows its working dots before the server's queue arrives.
  const hosted = hostedHydra({ state })
  const inFlight = pending.filter(item => item.failed === undefined)
  // An unsent message stays in the chat even while Hydra holds new input in the queue box.
  const shownSends = pending.filter(item => item.failed !== undefined
    || (!holding && !held.has(item.id)))
  const compactInputs = [
    ...chatQueue.compactInputs,
    ...inFlight.filter(item => holding && !held.has(item.id)).map(item => ({
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

  const unsent = sending.flatMap(({
    id,
    text,
    at,
    failed,
  }) => failed === undefined ? [] : [
    {
      id,
      text,
      at,
      failed,
    },
  ])
  const unsentKey = JSON.stringify(unsent)
  // A refused message outlives a reload or a Hydra switch, until a retry sends it.
  useEffect(
    () => saveUnsent({
      key: hydraId,
      items: unsent,
    }),
    [
      hydraId,
      unsentKey,
    ],
  )

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

  const listed: ChatEntry[] = withTimedRows({
    rows: chat.entries,
    timed: [
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
      ...shownDecisions.map(decision => ({
        id: decision.id,
        kind: 'message' as const,
        role: 'Hydra question',
        task: decision.card.id,
        text: '',
        at: decision.at,
      })),
      ...shownSends.map(s => ({
        id: s.id,
        kind: 'message' as const,
        role: 'user',
        text: s.text,
        at: s.at,
        sending: !s.confirmed && s.failed === undefined,
        unsent: s.failed,
      })),
    ],
  })
  const entries = keepStreamedKeys({
    entries: listed,
    previous: previousEntries.current,
    keys: streamedKeys.current,
  })
  previousEntries.current = entries
  // The reply to the owner's last send is the first text that streams once the send's own turn started, and was not
  // already streaming when it was sent.
  const sendTurn = lastSend.current !== undefined && chatQueue.started.includes(lastSend.current)
  const newReply = sendTurn && entries.some(entry => entry.streaming && entry.text
    && !streamingAtSend.current.has(entry.id))
  useLayoutEffect(() => {
    if (newReply) {
      firstTextShown({ hydraId })
      lastSend.current = undefined
    } else if (sendTurn && chatQueue.working) {
      sendTurnWorked.current = true
    } else if (sendTurn && sendTurnWorked.current) {
      // The send's turn ended without streamed text, such as a turn that only ran tools.
      forgetSend({ hydraId })
      lastSend.current = undefined
    }
  })
  useEffect(
    () => () => forgetSend({ hydraId }),
    [hydraId],
  )

  const threadSession = useRef(card?.agent?.sessionId)
  useLayoutEffect(
    () => {
      threadSession.current = card?.agent?.sessionId
    },
    [card?.agent?.sessionId],
  )

  const historyRequest = useRef<{
    id: number
    mode: HistoryMode
  } | null>(null)
  const historyGeneration = useRef(0)
  // The server keeps only the recent pages, or a read asking it to is on its way.
  const serverTrims = () => page?.recent === true || liveThread?.recent === true
    || historyRequest.current?.mode === 'recent'
  // A window read that failed waits for the owner's reading state or the connection to change before it retries.
  const failedHistory = useRef<HistoryMode>(undefined)
  useEffect(
    () => {
      failedHistory.current = undefined
    },
    [
      away,
      selectedHistory,
      connected,
    ],
  )
  useEffect(
    () => {
      if (!connected || !page || loadingEarlier) {
        return
      }

      const mode = historyRead({
        page,
        reading: away || selectedHistory,
        serverTrims: serverTrims(),
        pending: historyRequest.current?.mode,
        failed: failedHistory.current,
      })

      if (!mode) {
        return
      }

      const id = ++historyGeneration.current
      historyRequest.current = {
        id,
        mode,
      }
      const session = threadSession.current

      const recentArgs = [
        HYDRA_CARD,
        '--recent',
      ]
      // A retaining read only comes for a page that holds entries.
      const oldest = page.entries[0]
      const args = mode === 'retain' && oldest ? retainArgs({
        page,
        oldest,
      }) : recentArgs

      const read = async () => {
        try {
          const result = await command({
            name: 'thread',
            args,
          })

          const current = historyRequest.current?.id === id
          const reading = readingNow()

          if (threadSession.current === session && current && (mode !== 'recent' || !reading)) {
            const latest = result.thread as ThreadPage
            setPage(before => receivePage({
              before,
              latest,
            }))
          }
        } catch (error) {
          if (!(error instanceof CommandFailure && error.code === 'THREAD_SUPERSEDED')) {
            failedHistory.current = mode
            notify({ text: (error as Error).message })
          }
        } finally {
          if (historyRequest.current?.id === id) {
            historyRequest.current = null
          }
        }
      }

      read()
    },
    [
      connected,
      page,
      away,
      selectedHistory,
      liveThread,
      loadingEarlier,
      command,
    ],
  )

  const loadEarlier = async ({
    until,
    message,
  }: {
    until?: string
    message?: string
  }) => {
    stopFollowing()
    const session = threadSession.current
    let current = page

    const oldest = page?.entries[0]

    if (page && oldest && serverTrims()) {
      const restored = await command({
        name: 'thread',
        args: retainArgs({
          page,
          oldest,
        }),
      })
      current = restored.thread as ThreadPage
    }

    const earlier = await loadEarlierMessages({
      past: current,
      cursor: current?.older,
      until,
      message,
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
        // The source row must be committed before its caller reads the note and passage from the DOM.
        flushSync(() => setPage(before => receivePage({
          before,
          latest: earlier,
        })))
      }
    }
  }

  const loadComment = async ({ comment }: { comment: ChatComment }) => {
    stopFollowing()
    const selector = `[data-comment-id="${CSS.escape(comment.id)}"] textarea`

    if (content.current?.querySelector(selector)) {
      return
    }

    setLoadingEarlier(true)

    try {
      await loadEarlier({
        until: comment.at,
        message: comment.messageId,
      })
    } finally {
      setLoadingEarlier(false)
    }
  }

  const jumpDecision = async ({ decision }: { decision: ChatDecision }) => {
    stopFollowing()
    setLoadingEarlier(true)

    try {
      const selector = `[data-entry-id="${CSS.escape(decision.id)}"]`
      const target = () => stream.current?.querySelector<HTMLElement>(selector)

      if (!target()) {
        await loadEarlier({ until: decision.at })
      }

      requestAnimationFrame(() => {
        const question = target()

        if (question) {
          centerMessage({ element: question })
          question.querySelector<HTMLElement>('.ask button:not(:disabled), .ask textarea')?.focus({ preventScroll: true })
        }
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setLoadingEarlier(false)
    }
  }

  // The dots start with the send and stay on until the turn ends, through streaming and tool calls.
  const running = working || (hosted && inFlight.length > 0)
  const lookupState = useRef(state)
  lookupState.current = state
  const lookup = useMemo(
    () => pnyxLookup({ state: () => lookupState.current }),
    [
      state.config,
      state.view?.customColumns,
    ],
  )
  // A send counts from the owner's message until the server says the turn began.
  const since = (working ? card?.workingSince : undefined)
    ?? inFlight.at(-1)?.at ?? null

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

    if (!element || !chatFollow.following()) {
      return
    }

    const left = element.scrollHeight - element.clientHeight - element.scrollTop

    if (left >= 1) {
      element.scrollTop += Math.ceil(left * GLIDE)
      glide.current = requestAnimationFrame(settle)
    }
  }

  const stopGlide = () => {
    cancelAnimationFrame(glide.current)
    glide.current = 0
  }

  const ownerScroll = () => {
    chatFollow.input({ at: performance.now() })
    stopGlide()
  }

  const stopFollowing = () => {
    chatFollow.stop()
    stopGlide()
  }

  const expandRow = ({ target }: { target: EventTarget }) => {
    if (target instanceof Element && target.closest('summary')) {
      chatFollow.expand({ at: performance.now() })
      stopGlide()
    }
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

        if (!chatFollow.following() || glide.current) {
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
        stopFollowing,
      )

      return () => {
        observer.disconnect()
        cancelAnimationFrame(glide.current)
        scroller.removeEventListener(
          MESSAGE_SCROLL,
          stopFollowing,
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
      const text = args[1] ?? ''
      const at = new Date().toISOString()

      const markFailed = ({ reason }: { reason: string }) => {
        forgetSend({ hydraId })
        setSending(items => withFailure({
          items,
          id,
          failed: reason,
        }))
        // Saved here too, so a refusal that arrives after the owner left this Hydra is still there on return.
        const saved = readUnsent({ key: hydraId })
        saveUnsent({
          key: hydraId,
          items: [
            ...saved.filter(item => item.id !== id),
            {
              id,
              text,
              at: saved.find(item => item.id === id)?.at ?? at,
              failed: reason,
            },
          ],
        })
      }

      chatFollow.resume()
      streamingAtSend.current = new Set(previousEntries.current.filter(entry => entry.streaming)
        .map(entry => entry.id))
      lastSend.current = id
      sendTurnWorked.current = false
      markSend({ hydraId })
      setSending(items => items.some(s => s.id === id) ? withFailure({
        items,
        id,
        failed: undefined,
      }) : [
        ...items,
        {
          id,
          text,
          at,
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
        markFailed({ reason: error.message })
        throw error
      })

      // Any answer means the server recorded the message; a Hydra that could not take it says why.
      setSending(items => items.map(s => s.id === id ? {
        ...s,
        confirmed: true,
      } : s))

      if (result.state === 'failed' && typeof result.detail === 'string') {
        notify({ text: result.detail })
      }

      return result
    },
    [
      command,
      notify,
      hydraId,
    ],
  )

  // A retry keeps the message's id, so a copy the server did record is never sent twice.
  const retry = ({ id }: { id: string }) => {
    const message = sending.find(item => item.id === id)

    if (message) {
      deliver({
        name: 'reply',
        args: [
          HYDRA_CARD,
          message.text,
          id,
        ],
      }).catch(() => {
        // The message stays marked not sent with the new reason.
      })
    }
  }

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
  const previousLeads = useRef<ReturnType<typeof answerLeads> | undefined>(undefined)
  const leadCards = knownCards({ state })
  const leads = useMemo(
    () => {
      const refs = new Set(conversation?.entries.map(entry => entry.reference) ?? [])
      const next = answerLeads({
        messages: state.hydraMessages?.filter(message => refs.has(message.id)),
        cards: leadCards,
        previous: previousLeads.current,
      })
      previousLeads.current = next

      return next
    },
    [
      state.hydraMessages,
      leadCards,
      conversation?.entries,
    ],
  )
  const canStop = runningChange || ((working || compacting) && card?.agent?.host === 'pnyx') || upgradeRunning
  const down = hosted ? hydraDown({ status: state.hydraStatus }) : undefined
  const errors = card?.attention.filter(a => a.key === 'pnyx:interrupted' || a.kind === 'interrupted') ?? []

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
        {down && <span className="hydra-status" role="status">{down}</span>}
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
            expandRow({ target: event.target })
          }}
          onPointerDown={event => {
            expandRow({ target: event.target })

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
            chatFollow.scrolled({
              at: performance.now(),
              top: el.scrollTop,
              remaining: el.scrollHeight - el.scrollTop - el.clientHeight,
            })
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
              answerLeads={leads}
              comments={comments}
              drafts={drafts}
              quote={({ text }) => setDraft({
                text: quoteInto({
                  draft: drafts.read().text,
                  text,
                }),
              })}
              toolDetails={view.toolDetails}
              thinkingDetails={view.thinkingDetails}
              sendAgain={sendAgain}
              retry={retry}
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
                chatFollow.resume()
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
        loadComment={loadComment}
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
        drafts={drafts}
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
