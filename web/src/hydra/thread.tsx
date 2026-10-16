import { Icon } from '../components/ui/icon.tsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Card, HydraState, ViewPreferences } from '../../../src/core/model.ts'
import { traces } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { joinMessageParts, quoteInto, type ChatComment } from './chat.ts'
import { ComposerSettings } from './agent-settings.tsx'
import { Composer } from './composer.tsx'
import { Messages } from './messages.tsx'
import { InlinePermissions } from './permissions.tsx'
import { InlineQuestions } from './questions.tsx'
import { taskConversation } from '../../../src/thread/task.ts'
import type { TaskMessageReceipt } from '../../../src/cli/task-message.ts'
import { receiptLabel } from './view.ts'
import { agentActivity } from './view.ts'
import type { Command } from './connection.ts'

export const merge = ({ kept, page }: { kept: ThreadEntry[]; page: ThreadEntry[] }) => {
  const ids = new Set(page.map(e => e.id))

  return [...kept.filter(e => !ids.has(e.id)), ...page]
}

export function Thread({
  card,
  state,
  openTask,
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
  children,
}: {
  card: Card
  state: HydraState
  openTask({ id }: { id: string }): void
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
  children?: ReactNode
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
    const stream = scroller.current

    if (stream) {
      stream.scrollTop = stream.scrollHeight
    }

    atBottom.current = true; setLatest(false)
  }

  useEffect(() => {
    if (atBottom.current) {
      scrollToLatest()
    } else {
      setLatest(true)
    }
  }, [page, card.statusLog?.length])

  useEffect(() => {
    scroller.current?.closest('.detail')?.querySelector<HTMLTextAreaElement>('.composer textarea')
      ?.focus({ preventScroll: true })
  }, [])

  const deliver = useCallback<Command>(async ({ name, args }) => {
    if (name !== 'reply') {
      return command({ name, args })
    }

    const result = await command({ name: 'task-message', args })
    const receipt = result.reply as TaskMessageReceipt
    const detail = Object.entries(receipt.routes).map(([route, delivery]) => `${route === 'hydra' ? 'Hydra' : 'Agent'}: ${receiptLabel({ state: delivery.state })}${delivery.detail ? ` (${delivery.detail})` : ''}`)
      .join(' · ')

    return { ...result, reply: { ...receipt, detail } }
  }, [command])

  const shown = merge({ kept, page: page?.entries ?? [] })
    .filter(e => e.kind === 'message' || (e.kind === 'tool' ? tools : thinking))
  const entries = taskConversation({ card, entries: joinMessageParts({ entries: shown }) })

  return (
    <div className="task-conversation">
      <div
        className="thread"
        data-key-scope="thread"
        role="region"
        aria-label="Agent conversation"
        tabIndex={0}
        ref={scroller}
        onScroll={e => {
          const stream = e.currentTarget
          atBottom.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40

          if (atBottom.current) {
            setLatest(false)
          }
        }}
      >
        {children}
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
        {page?.unavailable && card.agent && <p className="empty">{page.unavailable}</p>}
        {!page && <p className="empty" role="status">Loading conversation…</p>}
        <Messages
          entries={entries}
          openTask={openTask}
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
      </div>
      <p className="task-recipient">{card.agent ? 'To agent and Hydra' : 'To Hydra · context saved for assignment'}</p>
      <Composer
        card={card.id}
        cards={Object.values(state.cards)}
        openTask={openTask}
        title={card.title}
        draft={draft}
        setDraft={setDraft}
        comments={comments}
        setComments={setComments}
        thread={page}
        height={view.taskComposerHeight}
        command={deliver}
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
      {latest && (
        <Button
          className="jump"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={scrollToLatest}
        >
          <Icon name="arrow_down" size={14} />
        </Button>
      )}
    </div>
  )
}
