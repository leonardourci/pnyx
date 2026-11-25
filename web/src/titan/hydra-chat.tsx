import { statusLabel } from '#tasks/card-status.ts'
import { observedStatus } from '#web-tasks/observed-status.ts'
import type { PendingTurn } from '#web-workers/pending-turns.ts'
import { kept } from '#web-shared/stable.ts'
import { useDraftSnapshot, type ChatDrafts } from './chat-drafts.ts'
import type { TitanState } from '#app/model.ts'
import type { CurrentAction } from '#titan/calls.ts'
import type { TitanChatQueue } from '#titan/chat-queue.ts'
import { hydraConfig } from '#titan/config.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { ThreadPage } from '#titan/transcripts-read.ts'
import type { TitanQueue } from '#titan/wakes.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { VIEW_SIZE_LIMITS, traces } from '#preferences/view.ts'
import { knownCards } from '#tasks/select.ts'
import type { Command } from '#web-app/connection.ts'
import { firstTextShown, forgetSend, markSend } from '#web-app/log.ts'
import { Resize } from '#web-shared/ui/resize.tsx'
import { InlineQuestions } from '#web-tasks/questions.tsx'
import { AnsweredQuestions } from '#web-tasks/answered-questions.tsx'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { WaitingDecisions } from '#web-tasks/waiting-decisions.tsx'
import { UpgradeRow } from '#web-upgrade/upgrade-row.tsx'
import { CompactionRow,CompactionRun } from '#web-workers/compaction.tsx'
import { DispatchProposals } from '#web-workers/dispatch-proposals.tsx'
import { InlinePermissions } from '#web-workers/permissions.tsx'
import { UsageRing } from '#web-workers/usage-ring.tsx'
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react'
import { ActionBubble } from './action-bubble.tsx'
import { answerLeads } from './answer-leads.ts'
import { ChatDecisionCard } from './chat-decisions.tsx'
import { chatDecisions, type ChatDecision } from './chat-questions.ts'
import { compactionRuns,hydraDown,noticesInTimeline,quoteInto,withTimedRows } from './chat.ts'
import { useChatScroll } from './chat-scroll.ts'
import { useChatThread } from './chat-thread.ts'
import { CHAT_FRAME, Chat } from './chat-view.tsx'
import { sendChatMessage } from './chat-send.ts'
import { centerMessage } from './comment-motion.ts'
import { useComposerSources } from './composer-sources.tsx'
import { Composer } from './composer.tsx'
import { TitanAgent } from './hydra-agent.tsx'
import { TitanHead } from './hydra-head.tsx'
import { type TitanIdentity } from './hydra-title.tsx'
import { Messages,type ChatEntry } from './messages.tsx'
import { othrysLookup } from './othrys-action.ts'
import { TITAN_SEND_SETTLED,readUnsent,saveUnsent } from './outbox.ts'
import { Running } from './running-indicator.tsx'

// What the chat shows until the server's first queue arrives.
const EMPTY_CHAT_QUEUE: TitanChatQueue = {
  compacting: undefined,
  upgrades: [],
  held: [],
  compactOperations: [],
  shownUpgrades: [],
  upgrading: false,
  holding: false,
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

export function TitanChat({
  hydraId,
  storageIdentity,
  state,
  command,
  connected,
  notify,
  view,
  save,
  drafts,
  liveThread: page,
  queue,
  identity,
  editTitan,
  projectRequest,
  projectRequested,
  openTask,
  action,
  taskActions,
  selectedTask,
  pendingTurn,
}: {
  hydraId: string
  storageIdentity: string
  // The Titan's name and icon for the header, and the names of the owner's other Titans.
  identity?: {
    name: string
    icon?: string
    taken: string[]
  }
  editTitan?({
    name,
    icon,
  }: TitanIdentity): void
  projectRequest?: boolean
  projectRequested?(): void
  action?: CurrentAction
  pendingTurn?: PendingTurn
  selectedTask?: string | null
  taskActions?: Record<string, CurrentAction>
  liveThread: ThreadPage | null
  queue: TitanQueue
  state: TitanState
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
  const scroll = useChatScroll()

  useEffect(
    () => {
      if (new URLSearchParams(location.search).has('new-chat')) {
        scroll.scroller.current?.closest('.hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea')
          ?.focus()
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
    width,
    setWidth,
  ] = useState<number | null>(null)
  const [
    sending,
    setSending,
  ] = useState<Sending[]>(() => readUnsent({
    key: hydraId,
    hydraId: storageIdentity,
  }).map(item => ({
    ...item,
    confirmed: false,
  })))
  const previousEntries = useRef<ChatEntry[]>([])
  const streamingAtSend = useRef(new Set<string>())
  const lastSend = useRef<string>(undefined), sendTurnWorked = useRef(false)
  const config = hydraConfig({ state }), card = state.cards[TITAN_CARD]
  const { catalog } = useComposerSources()
  const thread = useChatThread({
    card: TITAN_CARD,
    session: card?.agent?.sessionId,
    page,
    command,
    connected: connected && !!card,
    scroll,
  })
  const chatQueue = queue.chat ?? EMPTY_CHAT_QUEUE
  const pending = sending.filter(item => {
    return !page?.conversation?.entries.some(entry =>
      entry.reference === item.id || entry.id === item.id)
  })
  const {
    compacting,
    compactOperations,
    shownUpgrades,
    upgradeRunning,
    working,
  } = chatQueue
  const inFlight = pending.filter(item => item.failed === undefined)

  // Stops Titan's turn, its compaction or the upgrade running in their place.
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
      const refresh = ({
        id,
        refusal,
      }: {
        id?: string
        refusal?: string
      } = {}) => {
        const saved = readUnsent({
          key: hydraId,
          hydraId: storageIdentity,
        })
        const refused = new Map(saved.map(item => [
          item.id,
          item,
        ]))
        setSending(current => {
          const next = current.map(item => {
            const saved = refused.get(item.id)
            refused.delete(item.id)

            if (id === item.id && refusal === undefined) {
              return {
                ...item,
                confirmed: true,
                failed: undefined,
              }
            }

            return saved ? {
              ...item,
              confirmed: false,
              failed: saved.failed,
            } : item
          })
          next.push(...[...refused.values()].map(item => ({
            ...item,
            confirmed: false,
          })))

          return kept({
            previous: current,
            next,
          })
        })
      }

      const settled = (event: Event) => {
        if (event instanceof CustomEvent && event.detail.hydraId === hydraId) {
          refresh(event.detail)
        }
      }

      refresh()
      window.addEventListener(
        TITAN_SEND_SETTLED,
        settled,
      )

      return () => window.removeEventListener(
        TITAN_SEND_SETTLED,
        settled,
      )
    },
    [
      hydraId,
      storageIdentity,
    ],
  )

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
  // A refused message outlives a reload or a Titan switch, until a retry sends it.
  useEffect(
    () => saveUnsent({
      key: hydraId,
      hydraId: storageIdentity,
      items: unsent,
    }),
    [
      hydraId,
      storageIdentity,
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
  const olderCursor = page?.older
  const conversation = page?.conversation
  const chat = {
    entries: (conversation?.entries ?? []).map<ChatEntry>(entry => ({
      ...entry,
      unsent: entry.receipt === 'failed' && entry.waiting !== 'stopped' ? entry.waiting : undefined,
    })),
    folds: new Map(Object.entries(conversation?.folds ?? {})),
    timings: new Map(Object.entries(conversation?.timings ?? {})),
    trailing: new Map(Object.entries(conversation?.trailing ?? {})),
  }
  const decisions = chatDecisions({
    state,
    selectedTask,
    draft,
  })
  const shownDecisions = noticesInTimeline({
    notices: decisions,
    at: ({ notice }) => notice.at,
    rows: chat.entries,
    older: olderCursor !== undefined,
  })
  const inline = new Map(shownDecisions.map(decision => [
    decision.id,
    <ChatDecisionCard
      key={decision.id}
      decision={decision}
      command={command}
      notify={notify}
    />,
  ]))

  const loadedCompactions = noticesInTimeline({
    notices: compactOperations,
    at: ({ notice }) => notice.startedAt,
    rows: chat.entries,
    older: olderCursor !== undefined,
  })
  const compactionUnits = compactionRuns({
    operations: loadedCompactions,
    rows: chat.entries,
  })

  const compactionId = ({ unit }: { unit: typeof compactionUnits[number] }) =>
    `${unit.length > 1 ? 'compact-run' : 'compact'}:${unit[0]!.id}`

  for (const unit of compactionUnits) {
    const first = unit[0]!
    inline.set(
      compactionId({ unit }),
      unit.length > 1 ? <CompactionRun key={first.id} operations={unit} />
        : <CompactionRow key={first.id} operation={first} />,
    )
  }

  const loadedUpgrades = noticesInTimeline({
    notices: shownUpgrades,
    at: ({ notice }) => notice.startedAt ?? notice.queuedAt,
    rows: chat.entries,
    older: olderCursor !== undefined,
  })

  for (const operation of loadedUpgrades) {
    inline.set(
      `upgrade:${operation.id}`,
      <UpgradeRow
        key={operation.id}
        operation={operation}
        askTitan={setDraft}
        stop={stop}
        restartNow={async () => {
          try {
            await command({
              name: 'compact',
              args: [
                TITAN_CARD,
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
      ...compactionUnits.map(unit => ({
        id: compactionId({ unit }),
        kind: 'message' as const,
        role: 'Othrys',
        text: '',
        at: unit[0]!.startedAt,
      })),
      ...loadedUpgrades.map(operation => ({
        id: `upgrade:${operation.id}`,
        kind: 'message' as const,
        role: 'Othrys',
        text: '',
        at: operation.startedAt ?? operation.queuedAt,
      })),
      ...shownDecisions.map(decision => ({
        id: decision.id,
        kind: 'message' as const,
        role: 'Titan question',
        task: decision.card.id,
        text: '',
        at: decision.at,
      })),
      ...pending.map(s => ({
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
  const entries = listed
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

  const jumpDecision = async ({ decision }: { decision: ChatDecision }) => {
    scroll.stopFollowing()

    try {
      const selector = `[data-entry-id="${CSS.escape(decision.id)}"]`
      const target = () => scroll.scroller.current?.querySelector<HTMLElement>(selector)

      if (!target()) {
        await thread.loadEarlier({ until: decision.at })
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
    }
  }

  const status = observedStatus({
    card,
    state,
    action,
    pending: pendingTurn,
  })
  const running = status.kind === 'working'
  const lookupState = useRef(state)
  lookupState.current = state
  const lookup = useMemo(
    () => othrysLookup({ state: () => lookupState.current }),
    [
      state.config,
      state.projects,
    ],
  )
  const since = running ? card?.workingSince ?? inFlight.at(-1)?.at ?? null : null

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
        // Saved here too, so a refusal that arrives after the owner left this Titan is still there on return.
        const saved = readUnsent({
          key: hydraId,
          hydraId: storageIdentity,
        })
        saveUnsent({
          key: hydraId,
          hydraId: storageIdentity,
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

      scroll.toEnd()
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
      const result = await sendChatMessage({
        command,
        card: TITAN_CARD,
        text,
        id,
        onChecking,
      }).catch((error: Error) => {
        markFailed({ reason: error.message })
        throw error
      })

      // Any answer means the server recorded the message; a Titan that could not take it says why.
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
      storageIdentity,
    ],
  )

  const retry = ({
    id,
    reference,
    text,
  }: ChatEntry) => {
    deliver({
      name: 'reply',
      args: [
        TITAN_CARD,
        text,
        reference ?? id,
      ],
    }).catch((error: Error) => notify({ text: error.message }))
  }

  const route: ThreadPage = {
    ...page,
    card: TITAN_CARD,
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
      const next = answerLeads({
        entries: conversation?.entries,
        cards: leadCards,
        previous: previousLeads.current,
      })
      previousLeads.current = next

      return next
    },
    [
      leadCards,
      conversation?.entries,
    ],
  )
  const canStop = ((working || compacting) && card?.agent?.host === 'pnyx') || upgradeRunning
  const down = hydraDown({ status: state.hydraStatus })
  const showsTools = traces({
    view,
    card: TITAN_CARD,
  }).tools
  const statusLine = (card || pendingTurn) && !compacting ? (
    <TaskReferencesProvider references={references} openTask={openTask}>
      <Running
        since={since}
        running={running}
        label={statusLabel({ status })}
        statusName="Titan status"
        reading={queue.reading}
        waiting={queue.waiting}
        state={state}
      >
        {running && showsTools && <ActionBubble action={action} since={since} lookup={lookup} />}
      </Running>
    </TaskReferencesProvider>
  ) : null

  return (
    <aside
      className={`hydra-chat relative flex-none min-h-0 flex flex-col border border-line rounded-xl bg-surface overflow-visible max-phone:w-70 max-phone:basis-70 ${CHAT_FRAME}`}
      aria-label="Titan’s chat"
      style={{
        width: width ?? view.hydraWidth,
        flexBasis: width ?? view.hydraWidth,
      }}
    >
      <TitanHead
        name={identity?.name ?? config.name}
        icon={identity?.icon}
        taken={identity?.taken ?? []}
        editTitan={editTitan}
        connected={connected}
      >
        {down && <span className="hydra-status ml-auto shrink-0 text-red font-normal text-meta font-sans leading-[normal] not-italic tracking-normal" role="status">{down}</span>}
      </TitanHead>
      <Chat
        title="Titan"
        scroll={scroll}
        older={thread.older}
        loadingEarlier={thread.loadingEarlier}
        error={thread.error}
        status={statusLine}
      >
        <Messages
          catalog={catalog}
          labelColors={state.labelColors}
          folds={chat.folds}
          trailing={chat.trailing}
          timings={chat.timings}
          inline={inline}
          entries={entries}
          lookup={lookup}
          assistantLabel="Titan"
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

          retry={retry}
        />
        <DispatchProposals
          state={state}
          command={command}
          connected={connected}
          notify={notify}
        />
        {!entries.length && (
          <p className="hydra-empty mt-3 text-muted text-ui">
            What are we working on?
          </p>
        )}
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
      </Chat>
      <WaitingDecisions
        hydraId={hydraId}
        command={command}
        notify={notify}
        triggerRef={waitingButton}
        state={state}
        open={async ({ decision }) => {
          const question = decisions.find(item =>
            item.card.id === decision.card.id && item.ask.id === decision.id)

          if (decision.card.id === TITAN_CARD && question) {
            await jumpDecision({ decision: question })
          } else {
            openTask({ id: decision.card.id })
          }
        }}
        loading={thread.loadingEarlier}
      />
      <Composer
        hydraId={hydraId}
        storageIdentity={storageIdentity}
        loadComment={thread.loadComment}
        compacting={Boolean(compacting)}
        focusAbove={() => {
          if (!waitingButton.current || waitingButton.current.disabled) {
            return false
          }

          waitingButton.current.focus()

          return true
        }}
        card={TITAN_CARD}
        title="Titan"
        drafts={drafts}
        thread={route}
        command={deliver}
        notify={notify}
        projectRequest={projectRequest}
        projectRequested={projectRequested}
        stop={canStop ? stop : undefined}
        meter={<UsageRing card={card} command={command} connected={connected} />}
        settings={(
          <TitanAgent
            state={state}
            command={command}
            connected={connected}
            notify={notify}
          />
        )}
      />
      <Resize
        label="Resize Titan panel"
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
