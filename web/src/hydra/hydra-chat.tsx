import { activeCompaction } from '../../../src/compaction/state.ts'
import { CompactionQueue, CompactionRow } from '../compaction/compaction.tsx'
import { UPGRADE_COMMAND } from '../../../src/upgrade/model.ts'
import { UpgradeRow } from '../upgrade/upgrade-row.tsx'
import { Tooltip, TooltipPanel, TooltipSection } from '../shared/ui/tooltip.tsx'
import { useTaskReferences } from '../tasks/task-references.ts'
import { WaitingDecisions } from '../tasks/waiting-decisions.tsx'
import { loadEarlierMessages, mergeThreadPages } from './conversation-history.ts'
import { hydraConversation } from './conversation.ts'
import { chatDecisions, ChatDecisionCard, type ChatDecision } from './chat-decisions.tsx'
import { DispatchProposals } from '../workers/dispatch-proposals.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { REDUCED_MOTION, WorkingDots } from '../components/ui/streaming.tsx'
import { Button } from '../shared/ui/controls.tsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ownerActor } from '../../../src/app/actors.ts'
import type { HydraState } from '../../../src/app/model.ts'
import type { ViewPreferences } from '../../../src/preferences/model.ts'
import { HYDRA_CARD, hydraConfig } from '../../../src/core/hydra.ts'
import { traces, VIEW_SIZE_LIMITS } from '../../../src/preferences/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Resize } from '../shared/ui/resize.tsx'
import { TaskReferencesProvider } from '../tasks/task-reference.tsx'
import type { HydraQueue, QueuedUpdate } from '../../../src/app/host.ts'
import type { Command } from '../app/connection.ts'
import { InlineQuestions } from '../tasks/questions.tsx'
import { InlinePermissions } from './permissions.tsx'
import { Messages, type ChatEntry } from './messages.tsx'
import { pnyxLookup } from './pnyx-action.ts'
import { ActionBubble } from './action-bubble.tsx'
import { LiveLabel } from '../shared/ui/live-label.tsx'
import type { CurrentAction } from '../../../src/thread/calls.ts'
import { UsageRing } from './usage-ring.tsx'
import { Composer } from './composer.tsx'
import { useSkillsCatalog } from './skills-catalog.ts'
import { HydraAgent } from './hydra-agent.tsx'
import { MESSAGE_SCROLL } from './comment-motion.ts'
import { clock, duration, hydraPill, joinMessageParts, keepStreamedKeys, quoteInto, type ChatComment } from './chat.ts'

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
  const [
    catalogOpen,
    setCatalogOpen,
  ] = useState(false)
  const onCatalogOpen = useCallback(
    ({ open }: { open: boolean }) => setCatalogOpen(open),
    [],
  )
  const receiving = config.hydra.agent?.harness ?? card?.agent?.provider ?? 'claude'
  const catalog = useSkillsCatalog({
    identity: JSON.stringify([
      HYDRA_CARD,
      card?.agent?.provider,
      card?.agent?.cwd,
      card?.agent?.sessionId,
      receiving === 'claude-code' ? 'claude' : receiving,
    ]),
    card: HYDRA_CARD,
    command,
    connected,
    open: catalogOpen,
  })
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
  const compacting = activeCompaction({ card })
  const upgrades = state.upgrades ?? []
  // Messages a running upgrade holds wait in the same queue as compaction's.
  const upgradeHeld = upgrades.flatMap(operation => operation.held ?? [])
  const held = new Set([
    ...card?.compaction?.inputs.map(input => input.id) ?? [],
    ...upgradeHeld.map(message => message.id),
  ])
  const messages = (state.hydraMessages ?? []).filter(m => m.hydra === hydra.id)
  const compactOperations = card?.compaction?.operations ?? []
  // Only the newest result shows; a new attempt replaces the last one.
  const shownUpgrades = upgrades.filter(operation => operation.state !== 'queued')
    .sort((
      a,
      b,
    ) => a.queuedAt.localeCompare(b.queuedAt))
    .slice(-1)
  const upgrading = upgrades.some(operation => operation.state === 'running' || operation.state === 'restarting')
  const holding = Boolean(compacting) || upgrading
  const upgradeRunning = upgrades.some(operation => operation.state === 'running')

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

  const pending = sending.filter(s => !messages.some(m => m.id === s.id))
  // A queued /upgrade waits in the same box, with the same Send now.
  const compactInputs = [
    ...(card?.compaction?.inputs.filter(input => ownerActor({ actor: input.actor })) ?? []),
    ...upgrades.filter(operation => operation.state === 'queued').map(operation => ({
      id: operation.id,
      text: UPGRADE_COMMAND,
      actor: 'web',
      route: 'hydra' as const,
      at: operation.queuedAt,
    })),
    ...upgradeHeld.filter(message => ownerActor({ actor: message.actor })).map(message => ({
      ...message,
      route: 'hydra' as const,
    })),
    ...pending.filter(item => holding && !held.has(item.id)).map(item => ({
      ...item,
      actor: 'web',
      route: 'hydra' as const,
    })),
  ]
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
    messages: messages.filter(message => !held.has(message.id)),
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
  const references = useTaskReferences({ state })
  // Hydra reads only while its turn runs; a stale reading list from a finished turn shows nothing.
  const queueReading = running ? queue.reading : []
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
      <header className="hydra-head">
        <Icon name="hydra" size={24} />
        <strong>{config.name}</strong>
        {hosted && <span className="hydra-status" role="status" data-down={pill.down || undefined}>{pill.text}</span>}
      </header>
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
              catalog={catalog}
              labelColors={state.labelColors}
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
          </div>
        </div>
        {running && !compacting && (
          <TaskReferencesProvider references={references} openTask={openTask}>
            <Running
              since={running ? since : null}
              running={running}
              label={card?.agent ? 'Hydra is working' : 'Starting Hydra'}
              reading={queueReading}
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

          if (decision.kind === 'owner question' && question) {
            await jumpDecision({ decision: question })
          } else {
            openTask({ id: decision.card.id })
          }
        }}
        loading={loadingEarlier}
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
        compacting={Boolean(compacting)}
        serverComments={hosted}
        focusAbove={() => {
          if (!waitingButton.current || waitingButton.current.disabled) {
            return false
          }

          waitingButton.current.focus()

          return true
        }}
        card={HYDRA_CARD}
        catalog={catalog}
        onCatalogOpen={onCatalogOpen}
        labelColors={state.labelColors}
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
        notify={notify}
        stop={((working || compacting) && card?.agent?.host === 'pnyx') || upgradeRunning ? stop : undefined}
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

// The running dots and timer, and Hydra's queue built from Pnyx's own state: what it is reading and what waits for it.
function Running({
  since,
  running,
  label,
  reading,
  waiting,
  state,
  children,
}: {
  since: string | null
  running: boolean
  label: string
  reading: QueuedUpdate[]
  waiting: QueuedUpdate[]
  state: HydraState
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
    reading: reading.length,
    waiting: waiting.length,
    tasks: new Set(reading.map(update => update.card).filter(card => card !== HYDRA_CARD)).size,
  })

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
        {words && (
          <Tooltip
            content={(
              <TooltipPanel>
                {[
                  {
                    label: 'Reading',
                    updates: reading,
                  },
                  {
                    label: 'Waiting',
                    updates: waiting,
                  },
                ].filter(group => group.updates.length).map(group => (
                  <TooltipSection key={group.label}>
                    <strong>{group.label} {group.updates.length} {group.updates.length === 1 ? 'update' : 'updates'}</strong>
                    {group.updates.map(update => (
                      <span key={update.seq}>
                        {state.cards[update.card]?.title ?? 'Hydra'} · {update.kind ?? 'update'}
                      </span>
                    ))}
                  </TooltipSection>
                ))}
              </TooltipPanel>
            )}
          >
            <span tabIndex={0}>
              <LiveLabel
                value={words}
                keyOf={({ value }) => value}
                render={({ value }) => value}
              />
            </span>
          </Tooltip>
        )}
      </span>

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
  tasks,
}: {
  reading: number
  waiting: number
  tasks: number
}): string | null {
  const count = waiting > 0 ? `+${waiting} waiting` : null
  const read = `Reading ${reading} ${reading === 1 ? 'update' : 'updates'}${tasks > 1 ? ` across ${tasks} tasks` : ''}`

  if (reading > 0 && waiting > 0) {
    return `${read} · ${count}`
  }

  if (reading > 0) {
    return read
  }

  if (waiting > 0) {
    return count
  }

  return null
}
