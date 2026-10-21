import { DispatchProposals } from './dispatch-proposals.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Button } from '../components/ui/controls.tsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { type HydraState, type ViewPreferences } from '../../../src/core/model.ts'
import { HYDRA_CARD, hydraConfig } from '../../../src/core/hydra.ts'
import { taskUpdates } from '../../../src/thread/task.ts'
import { traces, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Resize } from '../components/ui/resize.tsx'
import type { Command } from './connection.ts'
import { InlineQuestions } from './questions.tsx'
import { InlinePermissions } from './permissions.tsx'
import { Messages, type ChatEntry } from './messages.tsx'
import { Composer } from './composer.tsx'
import { HydraAgent } from './hydra-agent.tsx'
import { clock, duration, hydraMessages, joinMessageParts, quoteInto, type ChatComment } from './chat.ts'

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
  projectSetup,
  openTask,
}: {
  projectSetup?: ReactNode
  liveThread: ThreadPage | null
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
  const follow = useRef(true), lastTop = useRef(0)
  const hydra = hydraConfig({ state }).hydra, card = state.cards[HYDRA_CARD]
  const {
    tools,
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
          setPage(result.thread as ThreadPage)
        }
      })
        .catch(() => {
          if (!cancelled) {
            setPage(null)
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
        setPage(liveThread)
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
  const transcript = joinMessageParts({ entries: page?.entries ?? [] })
  const updates = Object.values(state.cards).filter(c => !c.automaticTask && c.id !== HYDRA_CARD)
    .flatMap(card => taskUpdates({ card }))
  const chat = hydraMessages({
    messages,
    transcript,
    provider: card?.agent?.provider,
  })
  const entries: ChatEntry[] = [
    ...updates,
    ...chat,
    ...pending.map(s => ({
      id: s.id,
      kind: 'message' as const,
      role: 'user',
      text: s.text,
      at: s.at,
      sending: !s.confirmed,
    })),
  ]
    .filter(e => e.kind === 'message' || (e.kind === 'tool' ? tools : thinking))
    .sort((
      a,
      b,
    ) => (a.at ?? '').localeCompare(b.at ?? ''))
  const hosted = hydra.kind !== 'firstmate'
  const working = hosted && (card?.sessionActivity ?? card?.activity) === 'working'
  // The dots start with the send and stay on until the turn ends, through streaming and tool calls.
  const running = working || (hosted && pending.length > 0)
  // A send counts from the owner's message until the server says the turn began.
  const since = (working ? card?.workingSince : undefined)
    ?? pending.at(-1)?.at ?? null

  const bottom = () => {
    const element = stream.current

    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }

  useLayoutEffect(
    () => {
      const element = content.current

      if (!element || !stream.current) {
        return
      }

      const observer = new ResizeObserver(() => {
        if (follow.current) {
          bottom()
        }
      })
      observer.observe(element)
      observer.observe(stream.current)

      return () => observer.disconnect()
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
      <header className="hydra-head"><Icon name="hydra" size={24} /><strong>Hydra</strong></header>
      <div className="hydra-body">
        <div
          className="hydra-messages thread"
          ref={stream}
          data-key-scope="thread"
          role="region"
          aria-label="Hydra conversation"
          tabIndex={0}
          onScroll={e => {
            const el = e.currentTarget

            // Only scrolling up unpins: a pin's own scroll event can arrive after more text streamed in.
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              follow.current = true
            } else if (el.scrollTop < lastTop.current) {
              follow.current = false
            }

            lastTop.current = el.scrollTop
            setAway(!follow.current)
          }}
        >
          <div className="hydra-stream" ref={content}>
            {projectSetup && <div className="hydra-project-setup">{projectSetup}</div>}
            <Messages
              entries={entries}
              working={running}
              assistantLabel="Hydra"
              notify={notify}
              openTask={openTask}
              taskTitles={Object.fromEntries(Object.values(state.cards).map(c => [
                c.id,
                c.title,
              ]))}
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
        {running && <Running since={since} label={card?.agent ? 'Hydra is working' : 'Starting Hydra'} />}
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
      <Composer
        card={HYDRA_CARD}
        cards={Object.values(state.cards)}
        projects={state.projects ?? []}
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

function Running({
  since,
  label,
}: {
  since: string | null
  label: string
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

  return (
    <p
      className="chat-running"
      role="status"
      aria-label={label}
      title={since ? `Started ${clock({
        at: since,
        seconds: true,
      })}` : undefined}
    >
      <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
      {since && <span aria-hidden="true">{duration({ ms: now - Date.parse(since) })}</span>}
    </p>
  )
}
