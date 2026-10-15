import { useEffect, useRef, useState } from 'react'
import type { Card, ViewPreferences } from '../../../src/core/model.ts'
import { traces } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button, Switch } from '../components/ui/controls.tsx'
import { joinMessageParts, quoteInto, type ChatComment } from './chat.ts'
import { ComposerSettings } from './agent-settings.tsx'
import { Composer } from './composer.tsx'
import { Messages } from './messages.tsx'
import { InlineQuestions } from './questions.tsx'
import { agentActivity } from './view.ts'
import type { Command } from './connection.ts'

export const merge = ({ kept, page }: { kept: ThreadEntry[]; page: ThreadEntry[] }) => {
  const ids = new Set(page.map(e => e.id))

  return [...kept.filter(e => !ids.has(e.id)), ...page]
}

export function Thread({
  card,
  view,
  thread,
  kept,
  keep,
  older,
  keepOlder,
  command,
  connected,
  save,
  draft,
  setDraft,
  comments,
  setComments,
  notify,
}: {
  card: Card
  view: ViewPreferences
  thread: ThreadPage | null
  kept: ThreadEntry[]
  keep({ entries }: { entries: ThreadEntry[] }): void
  older: ThreadPage | null
  keepOlder({ page }: { page: ThreadPage }): void
  command: Command
  connected: boolean
  save({ patch }: { patch: unknown }): Promise<boolean>
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  notify({ text }: { text: string }): void
}) {
  const [latest, setLatest] = useState(false)
  const scroller = useRef<HTMLDivElement>(null), atBottom = useRef(true)
  const { tools, thinking, focus, overrides } = traces({ view, card: card.id })
  const page = thread?.card === card.id ? thread : null
  const olderCursor = older ? older.older : page?.older
  useEffect(() => {
    if (page) {
      keep({ entries: page.entries })
    }
  }, [page, keep])
  useEffect(() => {
    if (atBottom.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    } else {
      setLatest(true)
    }
  }, [page])

  const shown = merge({ kept, page: page?.entries ?? [] })
    .filter(e => e.kind === 'message' || (e.kind === 'tool' ? tools : thinking))
  const entries = joinMessageParts({ entries: shown })

  return (
    <>
      <div className="thread-controls row">
        <Switch label="Focus" checked={focus} onChange={({ value: focus }) => save({ patch: { cardTraceOverrides: { [card.id]: { tools: !focus, thinking: !focus } } } })} />
        <span className="small muted">{focus ? 'Prompts and agent messages only' : 'Showing tool calls and thinking'}</span>
        {overrides && <Button className="small" onClick={() => save({ patch: { cardTraceOverrides: { [card.id]: null } } })}>Use defaults</Button>}
      </div>
      <div
        className="thread"
        data-key-scope="thread"
        role="region"
        aria-label="Agent conversation"
        tabIndex={0}
        ref={scroller}
        onScroll={e => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40

          if (atBottom.current) {
            setLatest(false)
          }
        }}
      >
        {olderCursor !== undefined && (
          <Button
            onClick={() => {
              void command({ name: 'thread', args: [card.id, String(olderCursor)] })
                .then(r => keepOlder({ page: r.thread as ThreadPage }))
                .catch(e => notify({ text: e.message }))
            }}
          >
            Load older messages
          </Button>
        )}
        {page?.unavailable && <p className="empty">{page.unavailable}</p>}
        {!page && <p className="empty">{connected ? 'Loading conversation…' : 'Reconnect to load conversation.'}</p>}
        <Messages
          entries={entries}
          comments={comments}
          setComments={setComments}
          quote={({ text }) => setDraft({ text: quoteInto({ draft, text }) })}
        />
        {page && entries.length === 0 && !page.unavailable && <p className="empty">No recorded messages yet.</p>}
        {agentActivity({ card }) === 'working' && (
          <p className="running" role="status" title="Recorded activity; listener presence is unverified">
            <i aria-hidden="true" />
            Agent is running
          </p>
        )}
        <InlineQuestions
          card={card}
          command={command}
          connected={connected}
          notify={notify}
        />
        <Composer
          card={card.id}
          title={card.title}
          draft={draft}
          setDraft={setDraft}
          comments={comments}
          setComments={setComments}
          thread={page}
          height={view.composerHeight}
          command={command}
          save={save}
          connected={connected}
          notify={notify}
          settings={(
            <ComposerSettings
              card={card}
              thread={thread}
              command={command}
              connected={connected}
              notify={notify}
            />
          )}
        />
      </div>
      {latest && (
        <Button
          className="jump"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={() => {
            if (scroller.current) {
              scroller.current.scrollTop = scroller.current.scrollHeight
            }

            atBottom.current = true; setLatest(false)
          }}
        >
          <span aria-hidden="true">↓</span>
        </Button>
      )}
    </>
  )
}
