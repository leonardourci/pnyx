import { loadEarlierMessages, mergeThreadPages } from './conversation-history.ts'
import { hydraConversation } from './conversation.ts'
import { chatDecisions, ChatDecisionCard, WaitingDecisions, type ChatDecision } from './chat-decisions.tsx'
import { DispatchProposals } from './dispatch-proposals.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { REDUCED_MOTION, WorkingDots } from '../components/ui/streaming.tsx'
import { Button } from '../components/ui/controls.tsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { type HydraState, type ViewPreferences } from '../../../src/core/model.ts'
import { HYDRA_CARD, hydraConfig } from '../../../src/core/hydra.ts'
import { traces, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Resize } from '../components/ui/resize.tsx'
import { TaskReference, TaskReferencesProvider } from '../components/ui/task-reference.tsx'
import type { HydraQueue, QueuedUpdate } from '../../../src/server/host.ts'
import type { Command } from './connection.ts'
import { InlineQuestions } from './questions.tsx'
import { InlinePermissions } from './permissions.tsx'
import { Messages, type ChatEntry } from './messages.tsx'
import { pnyxLookup } from './pnyx-action.ts'
import { ActionBubble } from './action-bubble.tsx'
import { LiveLabel } from '../components/ui/live-label.tsx'
import type { CurrentAction } from '../../../src/thread/calls.ts'
import { UsageRing } from './usage-ring.tsx'
import { Composer } from './composer.tsx'
import { HydraAgent } from './hydra-agent.tsx'
import { cardState } from './view.ts'
import { MESSAGE_SCROLL } from './comment-motion.ts'
import { clock, duration, joinMessageParts, keepStreamedKeys, quoteInto, type ChatComment } from './chat.ts'

// How long after the owner's own input a scroll up still counts as theirs.
const OWNER_SCROLL_MS = 1000
// The share of the distance to the bottom that following covers per frame.
const GLIDE = 0.3

// Sends the server has not recorded yet; a confirmed one waits for its message to arrive.
interface Sending {
  id: string
  text: string
  at: string
  confirmed: boolean
}

export function HydraChat({
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
  projectSetup,
  openTask,
  action,
}: {
  projectSetup?: ReactNode
  action?: CurrentAction
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
  const {
    thinking,
  } = traces({
    view,
    card: HYDRA_CARD,
  })
  useEffect(
    () => {
      if (!connected || !card) {
        return
      }

      let cancelled = false
      void command({
        name: 'thread',
        args: [HYDRA_CARD],
      }).then(result => {
        if (!cancelled) {
          setPage(before => mergeThreadPages({
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
        setPage(before => mergeThreadPages({
          before,
          latest: liveThread,
        }))
      }
    },
    [liveThread],
  )
  const messages = (state.hydraMessages ?? []).filter(m => m.hydra === hydra.id)
  const pending = sending.filter(s => !messages.some(m => m.id === s.id))
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
  const transcript = joinMessageParts({ entries: page?.entries ?? [] })
  const actions = page?.actions ?? []
  const olderCursor = page?.older
  const firstAt = transcript[0]?.at
  const working = hydra.kind !== 'firstmate' && (card?.sessionActivity ?? card?.activity) === 'working'
  const chat = hydraConversation({
    messages,
    transcript,
    oldest: olderCursor ? firstAt : undefined,
    currentTurn: page?.currentTurn,
    provider: card?.agent?.provider,
    actions,
    titles: Object.fromEntries(Object.values(state.cards).map(card => [
      card.id,
      card.title,
    ])),
    columns: config.columns,
    working,
    thinking,
  })
  const decisions = chatDecisions({ cards: Object.values(state.cards) })
  const shownDecisions = decisions.filter(decision => {
    const loaded = firstAt !== undefined && decision.at >= firstAt

    return !olderCursor || loaded
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
  const listed: ChatEntry[] = [
    ...chat.entries,
    ...shownDecisions.map(decision => ({
      id: decision.id,
      kind: 'message' as const,
      role: 'Hydra question',
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
  threadSession.current = card?.agent?.sessionId

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
        setPage(latest => {
          if (!latest) {
            return earlier
          }

          return mergeThreadPages({
            before: earlier,
            latest,
          })
        })
      }
    }
  }

  const jumpDecision = async ({ decision }: { decision: ChatDecision }) => {
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
        target()?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    } finally {
      setLoadingEarlier(false)
    }
  }

  const hosted = hydra.kind !== 'firstmate'
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
  const deliver = useCallback<Command>(
    async ({
      name,
      args,
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
  const references = Object.fromEntries(Object.values(state.cards)
    .filter(c => c.id !== HYDRA_CARD && !c.automaticTask)
    .map(c => {
      const column = config.columns.find(column => column.id === c.column)
      const status = cardState({
        card: c,
        hours: state.config?.doneAfterHours,
        now: Date.now(),
      })

      return [
        c.id,
        {
          title: c.title,
          state: status.kind === 'asks' ? 'Needs you' : status.text.replace(
            /^./,
            letter => letter.toUpperCase(),
          ),
          kind: status.kind,
          column: column?.role ?? column?.id ?? 'custom',
        },
      ]
    }))
  // Hydra reads only while its turn runs; a stale reading list from a finished turn shows nothing.
  const queueReading = running ? queue.reading : []
  const queueShown = queue.waiting.length > 0 || queueReading.length > 0
  const queueCards = updatedTasks({
    updates: [
      ...queueReading,
      ...queue.waiting,
    ],
    tasks: Object.keys(references),
  })
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
      <header className="hydra-head"><Icon name="hydra" size={24} /><strong>{config.name}</strong></header>
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
            {projectSetup && <div className="hydra-project-setup">{projectSetup}</div>}
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
              folds={chat.folds}
              timings={chat.timings}
              inline={inline}
              entries={entries}
              working={running}
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
            />
            <DispatchProposals
              state={state}
              command={command}
              connected={connected}
              notify={notify}
            />
            {!entries.length && !projectSetup && <p className="hydra-empty">What are we working on?</p>}
            {errors.map(a => <p key={a.key} className="chat-error" role="alert"><Icon name="error" size={16} />{a.text}</p>)}
            {card && (
              <InlinePermissions
                card={{
                  ...card,
                  permissions: card.permissions?.filter(p => p.status === 'pending'),
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
            {/* ponytail: room for one wrapped row of task chips; more rows overlap the last message. */}
            {queueCards.length > 0 && <div className="chat-queue-room" aria-hidden="true" />}
          </div>
        </div>
        {(running || queueShown) && (
          <TaskReferencesProvider references={references} openTask={openTask}>
            <Running
              since={running ? since : null}
              running={running}
              label={card?.agent ? 'Hydra is working' : 'Starting Hydra'}
              reading={queueReading.length}
              waiting={queue.waiting.length}
              cards={queueCards}
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
        decisions={decisions.filter(decision => !decision.ask.answered)}
        jump={jumpDecision}
        loading={loadingEarlier}
      />
      <Composer
        card={HYDRA_CARD}
        cards={Object.values(state.cards)}
        projects={state.projects ?? []}
        columns={config.columns}
        taskReferences={references}
        openTask={openTask}
        title="Hydra"
        draft={draft}
        setDraft={setDraft}
        comments={comments}
        setComments={setComments}
        thread={route}
        command={deliver}
        connected={connected}
        notify={notify}
        stop={working && card?.agent?.host === 'pnyx' ? () => command({
          name: 'hydra',
          args: ['stop'],
        }).then(
          () => {},
          (error: Error) => notify({ text: error.message }),
        ) : undefined}
        meter={card?.agent?.host === 'pnyx' && <UsageRing command={command} connected={connected} turn={running} />}
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

// The tasks a group of updates is about, each once, leaving out any this Hydra does not show.
const updatedTasks = ({
  updates,
  tasks,
}: {
  updates: QueuedUpdate[]
  tasks: string[]
}) => [...new Set(updates.map(update => update.card))].filter(card => tasks.includes(card))

// The running dots and timer, and Hydra's queue built from Pnyx's own state: what it is reading and what waits for it.
function Running({
  since,
  running,
  label,
  reading,
  waiting,
  cards,
  children,
}: {
  since: string | null
  running: boolean
  label: string
  reading: number
  waiting: number
  // The tasks of the updates in Hydra's queue, each once.
  cards: string[]
  children?: ReactNode
}) {
  const [
    now,
    setNow,
  ] = useState(() => Date.now())
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        1000,
      )

      return () => clearInterval(timer)
    },
    [],
  )

  const words = queueWords({
    reading,
    waiting,
    cards: cards.length,
  })

  // The chips stay outside the live status, so a change never re-reads them or moves focus off one.
  return (
    <div
      className="chat-running"
      title={since ? `Started ${clock({
        at: since,
        seconds: true,
      })}` : undefined}
    >
      <span
        className="chat-running-status"
        role="status"
        aria-label={statusName({
          running,
          label,
          words,
        })}
      >
        {running && <WorkingDots />}
        {since && <span aria-hidden="true">{duration({ ms: now - Date.parse(since) })}</span>}
        {children}
        <LiveLabel
          value={words}
          keyOf={({ value }) => value}
          render={({ value }) => value}
        />
      </span>
      {cards.length > 0 && (
        <span className="chat-queue-tasks">
          {cards.map(card => (
            <span key={card} className="chat-queue-chip">
              <TaskReference id={card} />
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

// What the status says aloud: that Hydra is working, then what its queue holds.
function statusName({
  running,
  label,
  words,
}: {
  running: boolean
  label: string
  words: string | null
}): string | undefined {
  if (running && words) {
    return `${label}. ${words}`
  }

  if (running) {
    return label
  }

  return words ?? undefined
}

// What the running line says about Hydra's queue; null once it is empty.
function queueWords({
  reading,
  waiting,
  cards,
}: {
  reading: number
  waiting: number
  cards: number
}): string | null {
  const colon = cards > 0 ? ':' : ''

  if (reading > 0 && waiting > 0) {
    return `Hydra is reading, more waiting${colon}`
  }

  if (reading > 0) {
    return `Hydra is reading${colon}`
  }

  if (waiting > 0) {
    return `Waiting for Hydra${colon}`
  }

  return null
}
