import { useEffect, useRef, useState } from 'react'
import type { Card, ViewPreferences } from '../../../src/core/model.ts'
import { traces } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { joinMessageParts, quoteInto, type ChatComment } from './chat.ts'
import { ComposerSettings } from './agent-settings.tsx'
import { Composer } from './composer.tsx'
import { Messages } from './messages.tsx'
import { InlinePermissions } from './permissions.tsx'
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
  const { tools, thinking } = traces({ view, card: card.id })
  const page = thread?.card === card.id ? thread : null
  const olderCursor = older ? older.older : page?.older
  useEffect(() => {
    if (page) {
      keep({ entries: page.entries })
    }
  }, [page, keep])

  const scrollToLatest = () => {
    scroller.current?.querySelector('.composer')?.scrollIntoView({ block: 'end', inline: 'nearest' })
    atBottom.current = true; setLatest(false)
  }

  useEffect(() => {
    const column = scroller.current?.closest<HTMLElement>('.column-cards')

    if (!column) {
      return
    }

    const track = () => {
      const threadBox = scroller.current?.getBoundingClientRect()
      const viewBox = column.getBoundingClientRect()
      atBottom.current = !!threadBox && threadBox.bottom <= viewBox.bottom + 40
        && threadBox.bottom >= viewBox.top

      if (atBottom.current) {
        setLatest(false)
      }
    }

    column.addEventListener('scroll', track, { passive: true })

    return () => column.removeEventListener('scroll', track)
  }, [])
  useEffect(() => {
    if (atBottom.current) {
      scrollToLatest()
    } else {
      setLatest(true)
    }
  }, [page])

  const shown = merge({ kept, page: page?.entries ?? [] })
    .filter(e => e.kind === 'message' || (e.kind === 'tool' ? tools : thinking))
  const entries = joinMessageParts({ entries: shown })

  return (
    <>
      <div
        className="thread"
        data-key-scope="thread"
        role="region"
        aria-label="Agent conversation"
        tabIndex={0}
        ref={scroller}
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
        {!page && <p className="empty">Loading conversation…</p>}
        <Messages
          entries={entries}
          comments={comments}
          setComments={setComments}
          quote={({ text }) => setDraft({ text: quoteInto({ draft, text }) })}
          toolDetails={view.toolDetails}
          thinkingDetails={view.thinkingDetails}
        />
        {page && entries.length === 0 && !page.unavailable && <p className="empty">No recorded messages yet.</p>}
        {agentActivity({ card }) === 'working' && (
          <p className="running" role="status" title={card.agent?.host === 'pnyx' ? 'Pnyx runs this agent' : 'Recorded activity; listener presence is unverified'}>
            <i aria-hidden="true" />
            Agent is running
          </p>
        )}
        <InlinePermissions card={card} command={command} notify={notify} />
        <InlineQuestions
          card={card}
          command={command}
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
          onClick={scrollToLatest}
        >
          <span aria-hidden="true">↓</span>
        </Button>
      )}
    </>
  )
}
