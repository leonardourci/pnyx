import type { ReactNode } from 'react'
import type { Card as CardData, ViewPreferences } from '../../../src/core/model.ts'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'
import { agentActivity } from './view.ts'

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
}: {
  card: CardData
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
  const activity = agentActivity({ card })

  return (
    <article
      className={`card ${selected ? 'selected' : ''}`}
      data-task={card.id}
      onClick={e => {
        if (e.target instanceof Element && !e.target.closest('a, button, input, textarea, .detail') && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected && !selected && !editingTitle}
      onDragStart={e => {
        e.stopPropagation(); e.dataTransfer.setData('application/pnyx-task', card.id)
      }}
    >
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
      {activity && <span className={`agent-activity activity-${activity}`}><i aria-hidden="true" />{activity === 'working' ? 'Working' : 'Finished its turn'}</span>}
      {card.agent && view.lastMessageOnCards && latest && !selected && (
        <LastMessage message={latest} />
      )}
      {children}
    </article>
  )
}
