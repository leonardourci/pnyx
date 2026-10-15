import { useEffect, useState, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel } from './reminder.tsx'
import type { Card as CardData, ViewPreferences } from '../../../src/core/model.ts'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'
import { Menu } from '../components/ui/menu.tsx'
import { CopyId } from '../components/ui/copy-id.tsx'
import { HideAfter } from './hide-after.tsx'
import { cardState, projectTitle } from './view.ts'

function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message" title={message.text}>
      <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
      <p>{message.text}</p>
    </div>
  )
}

export function HydraCard({
  card,
  latest,
  selected,
  view,
  open,
  tabIndex,
  command,
  connected,
  editingTitle,
  titleFinished,
  children,
  doneAfterHours,
  notify,
}: {
  card: CardData
  doneAfterHours?: number
  notify({ text }: { text: string }): void
  latest?: LatestMessage
  selected: boolean
  view: ViewPreferences
  open({ id }: { id: string }): void
  tabIndex: number
  command: Command
  connected: boolean
  editingTitle: boolean
  titleFinished(): void
  children?: ReactNode
}) {
  const [reminding, setReminding] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)

    return () => clearInterval(timer)
  }, [])
  const status = cardState({ card, hours: doneAfterHours, now })

  return (
    <article
      className={`card ${selected ? 'selected' : ''}`}
      data-task={card.id}
      onClick={e => {
        if (e.target instanceof Element && !e.target.closest('a, button, input, textarea, form, .detail, .menu') && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected && !selected && !editingTitle && !reminding}
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
      {editingTitle ? (
        <InlineTitle
          value={card.title}
          label={`Rename task ${card.title}`}
          startEditing
          finished={titleFinished}
          save={({ title }) => command({ name: 'task', args: ['rename', card.id, `--title=${title}`, '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] }).then(() => titleFinished())}
        />
      )
        : (
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
        )}
      <div className="card-state">
        <span className={`agent-activity activity-${status.kind}`} title={status.at ? new Date(status.at).toLocaleString() : undefined}><i aria-hidden="true" />{status.text}</span>
        {status.kind === 'stopped' && (
          <Button
            className="card-resume"
            disabled={!connected}
            onClick={() => void command({ name: 'hydra', args: ['send', '--task', card.id, '--text', `Resume the stopped worker on task ${card.id}: ${card.title}. Read its history before continuing.`, '--event-id', crypto.randomUUID()] })
              .then(() => notify({ text: 'Asked Hydra to resume' }))
              .catch(e => notify({ text: e.message }))}
          >Resume
          </Button>
        )}
      </div>
      {card.copy?.state === 'flagged' && <span className="copy-warning" title={card.copy.reason}>copy not cleaned</span>}
      {card.agent && view.lastMessageOnCards && latest && !selected && (
        <LastMessage message={latest} />
      )}
      <ReminderLabel card={card} />
      {reminding && (
        <ReminderEditor
          card={card}
          command={command}
          connected={connected}
          close={() => setReminding(false)}
        />
      )}
      {children}
    </article>
  )
}
