import { useEffect, useRef, useState } from 'react'
import type { Card, ViewPreferences } from '../../../src/core/model.ts'
import { traces } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button, Switch } from '../components/ui/controls.tsx'
import { joinMessageParts, type ChatComment } from './chat.ts'
import { Composer } from './composer.tsx'
import { Messages } from './messages.tsx'
import { agentActivity } from './view.ts'
import type { Command } from './connection.ts'

export const merge = ({ kept, page }: { kept: ThreadEntry[]; page: ThreadEntry[] }) => {
  const ids = new Set(page.map(e => e.id))

  return [...kept.filter(e => !ids.has(e.id)), ...page]
}

// One conversation as a chat: the transcript, then the reply input as the next
// message. It needs only its card, so it can live in any panel.
export function Thread({
  card,
  view,
  thread,
  kept,
  setKept,
  older,
  setOlder,
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
  setKept(update: (kept: ThreadEntry[]) => ThreadEntry[]): void
  older: ThreadPage | null
  setOlder(page: ThreadPage): void
  command: Command
  connected: boolean
  save(patch: unknown): Promise<boolean>
  draft: string
  setDraft(text: string): void
  comments: ChatComment[]
  setComments(comments: ChatComment[]): void
  notify(text: string): void
}) {
  const [latest, setLatest] = useState(false)
  const scroller = useRef<HTMLDivElement>(null), atBottom = useRef(true)
  const { tools, thinking, focus, overrides } = traces({ view, card: card.id })
  const page = thread?.card === card.id ? thread : null
  const olderCursor = older ? older.older : page?.older
  useEffect(() => {
    if (page) {
      setKept(k => merge({ kept: k, page: page.entries }))
    }
  }, [page, setKept])
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
      <div className="thread-controls">
        <div className="row wrap">
          <Switch label="Focus" checked={focus} onChange={focus => save({ cardTraceOverrides: { [card.id]: { tools: !focus, thinking: !focus } } })} />
          <span className="small muted">{focus ? 'Prompts and agent messages only' : 'Showing tool calls and thinking'}</span>
        </div>
        <div className="row between small muted">
          <span>{overrides ? 'This card has overrides' : 'Following board defaults'}</span>
          <Button
            disabled={!overrides}
            onClick={() => save({ cardTraceOverrides: { [card.id]: null } })}
          >
            Use defaults
          </Button>
        </div>
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
              void command('thread', [card.id, String(olderCursor)]).then(r => {
                const p = r.thread as ThreadPage
                setOlder(p); setKept(k => merge({ kept: p.entries, page: k }))
              })
                .catch(e => notify(e.message))
            }}
          >
            Load older messages
          </Button>
        )}
        {page?.unavailable && <p className="empty">{page.unavailable}</p>}
        {!page && <p className="empty">{connected ? 'Loading conversation…' : 'Reconnect to load conversation.'}</p>}
        <Messages entries={entries} comments={comments} setComments={setComments} />
        {page && entries.length === 0 && !page.unavailable && <p className="empty">No recorded messages yet.</p>}
        {agentActivity({ card }) === 'working' && (
          <p className="running" role="status" title="Recorded activity; listener presence is unverified">
            <i aria-hidden="true" />
            Agent is running
          </p>
        )}
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
        />
      </div>
      {latest && (
        <Button
          className="jump"
          onClick={() => {
            if (scroller.current) {
              scroller.current.scrollTop = scroller.current.scrollHeight
            }

            atBottom.current = true; setLatest(false)
          }}
        >
          Jump to latest ↓
        </Button>
      )}
      <div className="watch-banner">
        <strong>Not watching · presence unverified</strong>
        <p>
          The source has no listener signal. Activity alone does not confirm it is watching.
        </p>
      </div>
    </>
  )
}
