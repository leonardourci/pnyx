import { useEffect, useState, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel } from './reminder.tsx'
import type { Card as CardData, ViewPreferences } from '../../../src/core/model.ts'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { Markdown } from '../components/ui/markdown.tsx'
import { Button } from '../components/ui/controls.tsx'
import { taskUpdates } from '../../../src/thread/task.ts'
import type { Command } from './connection.ts'
import { Menu } from '../components/ui/menu.tsx'
import { CopyId } from '../components/ui/copy-id.tsx'
import { HideAfter } from './hide-after.tsx'
import { useStartRequest } from './start-request.ts'
import { cardState, projectTitle } from './view.ts'

function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message" title={message.text}>
      <strong>Agent update</strong>
      <Markdown text={message.text} />
    </div>
  )
}

export function HydraCard({
  card,
  firstmate,
  latest,
  selected,
  view,
  open,
  tabIndex,
  command,
  connected,
  children,
  doneAfterHours,
  notify,
}: {
  card: CardData
  firstmate: boolean
  doneAfterHours?: number
  notify({ text }: { text: string }): void
  latest?: LatestMessage
  selected: boolean
  view: ViewPreferences
  open({ id }: { id: string }): void
  tabIndex: number
  command: Command
  connected: boolean
  children?: ReactNode
}) {
  const [reminding, setReminding] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)

    return () => clearInterval(timer)
  }, [])
  const { resume, busy } = useStartRequest({ card, firstmate, command, notify })
  const status = cardState({ card, hours: doneAfterHours, now })
  const update = taskUpdates({ card }).at(-1)
  const factual = update ? { role: 'assistant' as const, text: update.text, at: update.at } : !card.tracking && latest?.role === 'assistant' ? latest : undefined

  return (
    <article
      className={`card ${selected ? 'selected' : ''}`}
      data-task={card.id}
      onClick={e => {
        if (e.target instanceof Element && !e.target.closest('a, button, input, textarea, form, .detail, .menu') && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected && !selected && !reminding}
      onDragStart={e => {
        e.stopPropagation(); e.dataTransfer.setData('application/pnyx-task', card.id)
      }}
    >
      <div className="card-menu">
        <Menu label={`Card menu for ${card.title}`}>
          {!card.automaticTask && (
            <Button disabled={!connected} onClick={() => setReminding(true)}>Remind me…</Button>
          )}
          <CopyId id={card.id} notify={notify} />
          <HideAfter
            card={card}
            command={command}
            connected={connected}
            notify={notify}
          />
        </Menu>
      </div>
      {card.project && <span className="project-label" title={card.project}>{projectTitle({ project: card.project })}</span>}
      <Button
        className="card-open"
        aria-label={`Open conversation for ${card.title}`}
        aria-expanded={selected}
        onClick={() => open({ id: card.id })}
        data-card={card.id}
        data-key-scope="hydra"
        tabIndex={tabIndex}
      >{card.title}
      </Button>
      <div className="card-state">
        <span className={`agent-activity activity-${status.kind}`} title={status.at ? new Date(status.at).toLocaleString() : undefined}><i aria-hidden="true" />{status.text}</span>
        {status.kind === 'stopped' && (
          <Button
            className="card-resume"
            disabled={!connected || busy}
            onClick={resume}
          >Resume
          </Button>
        )}
      </div>
      {card.copy?.state === 'flagged' && <span className="copy-warning" title={card.copy.reason}>copy not cleaned</span>}
      {(!selected || reminding) && (
        <div className="card-rest">
          {view.lastMessageOnCards && !selected && (
            factual ? <LastMessage message={factual} /> : <p className="last-message">No agent update yet.</p>
          )}
          {reminding && (
            <ReminderEditor
              card={card}
              command={command}
              connected={connected}
              close={() => setReminding(false)}
            />
          )}
        </div>
      )}
      <ReminderLabel card={card} />
      {children}
    </article>
  )
}
