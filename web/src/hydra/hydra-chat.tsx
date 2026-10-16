import { Icon } from '../components/ui/icon.tsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { HYDRA_ACTOR, type HydraState, type ViewPreferences } from '../../../src/core/model.ts'
import { HYDRA_CARD, hydraConfig } from '../../../src/core/hydra.ts'
import { taskUpdates } from '../../../src/thread/task.ts'
import { traces, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Resize } from '../components/ui/resize.tsx'
import type { Command } from './connection.ts'
import { InlineQuestions } from './questions.tsx'
import { Messages } from './messages.tsx'
import { Composer } from './composer.tsx'
import { HydraAgent } from './hydra-agent.tsx'
import { joinMessageParts, quoteInto, type ChatComment } from './chat.ts'

export function HydraChat({
  state, command, connected, notify, view, save, draft, setDraft, comments, setComments,
  liveThread, projectSetup, openTask,
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
  const [page, setPage] = useState<ThreadPage | null>(liveThread)
  const [width, setWidth] = useState<number | null>(null)
  const stream = useRef<HTMLDivElement>(null), follow = useRef(true)
  const hydra = hydraConfig({ state }).hydra, card = state.cards[HYDRA_CARD]
  const { tools, thinking } = traces({ view, card: HYDRA_CARD })
  useEffect(() => {
    if (!connected || !card) {
      return
    }

    let cancelled = false
    void command({ name: 'thread', args: [HYDRA_CARD] }).then(result => {
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
  }, [connected, command, card?.agent?.sessionId, !!card])
  useEffect(() => {
    if (liveThread) {
      setPage(liveThread)
    }
  }, [liveThread])
  const messages = (state.hydraMessages ?? []).filter(m => m.hydra === hydra.id)
  const recorded: ThreadEntry[] = messages.map(m => ({ id: m.id, kind: 'message', role: m.actor === HYDRA_ACTOR ? 'assistant' : 'user', text: m.details ? `${m.text}\n\n${m.details}` : m.text, at: m.at }))
  const transcript = joinMessageParts({ entries: page?.entries ?? [] })
  const updates = Object.values(state.cards).filter(c => !c.automaticTask && c.id !== HYDRA_CARD)
    .flatMap(card => taskUpdates({ card }))
  const entries = [...updates, ...recorded.filter(m => !transcript.some(t => t.kind === 'message' && t.role === 'user' && t.text === m.text)), ...transcript]
    .filter(e => e.kind === 'message' || (e.kind === 'tool' ? tools : thinking))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  useEffect(() => {
    if (follow.current && stream.current) {
      stream.current.scrollTop = stream.current.scrollHeight
    }
  }, [messages.length, page])
  const deliver = useCallback<Command>(async ({ name, args }) => {
    if (name !== 'reply') {
      return command({ name, args })
    }

    const result = await command({ name: 'hydra', args: ['send', `--text=${args[1] ?? ''}`, '--event-id', args[2] ?? crypto.randomUUID()] })

    const queued = result.state === 'queued'

    return { reply: { state: queued ? 'queued' : 'failed' } }
  }, [command])
  const route: ThreadPage = { ...page, card: HYDRA_CARD, entries, route: true, watching: 'unknown' }

  return (
    <aside className="hydra-chat" aria-label="Hydra’s chat" style={{ width: width ?? view.hydraWidth, flexBasis: width ?? view.hydraWidth }}>
      <header className="hydra-head"><Icon name="hydra" size={24} /><strong>Hydra</strong></header>
      <div
        className="hydra-messages thread"
        ref={stream}
        data-key-scope="thread"
        role="region"
        aria-label="Hydra conversation"
        tabIndex={0}
        onScroll={e => {
          const el = e.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {projectSetup && <div className="hydra-project-setup">{projectSetup}</div>}
        <Messages
          entries={entries}
          openTask={openTask}
          taskTitles={Object.fromEntries(Object.values(state.cards).map(c => [c.id, c.title]))}
          comments={comments}
          setComments={setComments}
          quote={({ text }) => setDraft({ text: quoteInto({ draft, text }) })}
          toolDetails={view.toolDetails}
          thinkingDetails={view.thinkingDetails}
        />
        {!entries.length && !projectSetup && <p className="hydra-empty">What are we working on?</p>}
        {card && (
          <InlineQuestions
            card={card}
            command={command}
            notify={notify}
          />
        )}
      </div>
      <Composer
        card={HYDRA_CARD}
        cards={Object.values(state.cards)}
        openTask={openTask}
        title="Hydra"
        draft={draft}
        setDraft={setDraft}
        comments={comments}
        setComments={setComments}
        thread={route}
        height={view.composerHeight}
        command={deliver}
        save={save}
        connected={connected}
        notify={notify}
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
        max={VIEW_SIZE_LIMITS.hydraWidth.max}
        onPreview={({ value }) => setWidth(value)}
        onCommit={({ value }) => save({ patch: { hydraWidth: value } }).then(saved => {
          setWidth(null)

          return saved
        })}
      />
    </aside>
  )
}
