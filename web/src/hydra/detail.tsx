import { ReminderEditor } from './reminder.tsx'
import { useCallback, useState } from 'react'
import type { HydraState, Card, ViewPreferences } from '../../../src/core/model.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button, Input, Textarea } from '../components/ui/controls.tsx'
import { TaskSession } from './task-session.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import { Menu } from '../components/ui/menu.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { harnessName } from './agent-settings.tsx'
import { ContinueAgent } from './continue-agent.tsx'
import { StartAgent } from './start-agent.tsx'
import { needsAgent } from './view.ts'
import { merge, Thread } from './thread.tsx'
import type { ChatComment } from './chat.ts'
import type { Command } from './connection.ts'

function TaskBrief({ card, command, notify }: {
  card: Card
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [draft, setDraft] = useState(card.brief ?? ''), [busy, setBusy] = useState(false)

  return (
    <form
      className="task-brief"
      onSubmit={e => {
        e.preventDefault(); setBusy(true)
        void command({ name: 'task', args: ['brief', card.id, '--brief', draft, '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] })
          .catch(e => notify({ text: e.message }))
          .finally(() => setBusy(false))
      }}
    >
      <label htmlFor={`brief-${card.id}`}>Brief</label>
      <Textarea
        id={`brief-${card.id}`}
        aria-label="Task brief"
        placeholder="What should the agent work on?"
        value={draft}
        onChange={e => setDraft(e.target.value)}
      />
      <Button type="submit" disabled={busy || draft === (card.brief ?? '')}>Save brief</Button>
    </form>
  )
}

export function Detail({
  card,
  state,
  view,
  thread,
  command,
  connected,
  close,
  save,
  draft,
  setDraft,
  comments,
  setComments,
  createTask,
  notify,
}: {
  card: Card
  state: HydraState
  view: ViewPreferences
  thread: ThreadPage | null
  command: Command
  connected: boolean
  close(): void
  save({ patch }: { patch: unknown }): Promise<boolean>
  draft: string
  setDraft({ text }: { text: string }): void
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  createTask({ column, parent }: { column: string; parent?: string }): void
  notify({ text }: { text: string }): void
}) {
  const [kept, setKept] = useState<ThreadEntry[]>([])
  const [older, setOlder] = useState<ThreadPage | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [reminding, setReminding] = useState(false)
  const [starting, setStarting] = useState(false), [renaming, setRenaming] = useState(false)
  const keep = useCallback(({ entries }: { entries: ThreadEntry[] }) =>
    setKept(k => merge({ kept: k, page: entries })), [])
  const keepOlder = useCallback(({ page }: { page: ThreadPage }) => {
    setOlder(page); setKept(k => merge({ kept: page.entries, page: k }))
  }, [])
  const empty = needsAgent({ card }) || (thread && !thread.entries.length && !kept.length)

  return (
    <section aria-label={`Details for ${card.title}`} className="detail inline">
      <header className="detail-header">
        {card.agent && <span className="agent-chip">{`${harnessName({ provider: card.agent.provider })}${card.agent.host === 'pnyx' ? ' · Pnyx' : card.terminal?.tty ? ' · terminal' : ''}`}</span>}
        <div className="row">
          <Menu label="Task menu">
            <Button onClick={() => setRenaming(true)}>Rename task</Button>
            {!card.automaticTask && (
              <Button disabled={!connected} onClick={() => setReminding(true)}>Remind me…</Button>
            )}
            {!card.automaticTask && (
              <Button
                disabled={!connected}
                onClick={() => void command({ name: 'task', args: [card.hidden ? 'unhide' : 'hide', card.id, '--event-id', crypto.randomUUID()] }).then(() => close())
                  .catch(e => notify({ text: e.message }))}
              >{card.hidden ? 'Bring back to Hydra' : 'Hide from Hydra'}
              </Button>
            )}
            <Button onClick={() => setAttaching(value => !value)}>{card.agent ? 'Change agent' : 'Attach agent'}</Button>
            {needsAgent({ card }) && (
              <Button onClick={() => setStarting(value => !value)}>Start agent</Button>
            )}
            {!card.parentId && (
              <Button
                disabled={!connected}
                onClick={() => createTask({ column: card.column, parent: card.id })}
              >Add subtask
              </Button>
            )}
          </Menu>
          <Button aria-label="Close detail" onClick={close}><Icon name="close" size={14} /></Button>
        </div>
      </header>
      {card.agent && ['claude-code', 'codex'].includes(card.agent.provider) && !card.agent.host && !card.agent.agentId && !card.agent.paseoAgentId && !card.automaticTask && (
        <ContinueAgent
          card={card}
          command={command}
          connected={connected}
          fresh={() => setStarting(true)}
          notify={notify}
        />
      )}
      {renaming && (
        <InlineTitle
          value={card.title}
          label="Task title"
          finished={() => setRenaming(false)}
          startEditing
          save={({ title }) => command({ name: 'task', args: ['rename', card.id, '--title', title, '--event-id', crypto.randomUUID()] }).then(() => setRenaming(false))}
        />
      )}
      {renaming && (
        <Input
          aria-label="Task project label"
          defaultValue={card.project ?? ''}
          placeholder="Project label"
          onBlur={e => {
            if (e.target.value !== (card.project ?? '')) {
              void command({ name: 'task', args: ['rename', card.id, '--project', e.target.value, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
            }
          }}
        />
      )}
      {reminding && (
        <ReminderEditor
          card={card}
          command={command}
          connected={connected}
          close={() => setReminding(false)}
        />
      )}
      {attaching && (
        <TaskSession
          card={card}
          state={state}
          command={command}
          connected={connected}
          notify={notify}
        />
      )}
      {empty && <TaskBrief card={card} command={command} notify={notify} />}
      {starting && (
        <StartAgent
          card={card}
          replace={Boolean(card.agent)}
          firstmate={state.config?.hydra.kind === 'firstmate'}
          defaultHarness={state.config?.agents?.default?.harness}
          command={command}
          connected={connected}
          notify={notify}
        />
      )}
      {!needsAgent({ card }) && (
        <Thread
          card={card}
          view={view}
          thread={thread}
          kept={kept}
          keep={keep}
          older={older}
          keepOlder={keepOlder}
          command={command}
          connected={connected}
          save={save}
          draft={draft}
          setDraft={setDraft}
          comments={comments}
          setComments={setComments}
          notify={notify}
        />
      )}
    </section>
  )
}
