import { useState } from 'react'
import type { Card as CardData, Link, ViewPreferences } from '../../../src/core/model.ts'
import { traces, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { HybridHit } from '../../../src/search/semantic.ts'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Resize } from '../components/ui/resize.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import type { Command } from './connection.ts'
import { Harness, SettingChips } from './agent-settings.tsx'
import { agentActivity, needsAgent, receiptLabel, safeLink, taskLabel, visibleParent } from './view.ts'

export function Links({ links }: { links: Link[] }) {
  return (
    <div className="links">
      {links.map(l => {
        const href = safeLink({ link: l })

        return href && (
          <a
            key={l.url}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`${l.title ?? l.url} · opens in new tab`}
          >
            <Icon name={l.kind} />
            {l.kind === 'github_pr' ? `#${l.number ?? 'PR'}` : l.title ?? new URL(href).hostname}
          </a>
        )
      })}
    </div>
  )
}

export function Tags({ tags }: { tags: string[] }) {
  return <div className="tags">{tags.map(t => <span key={t} className={`tag tone-${[...t].reduce((n,c) => n + c.charCodeAt(0), 0) % 4}`}>{t}</span>)}</div>
}

// The last message of the card's conversation, two lines at most.
function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message" title={message.text}>
      <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
      <p>{message.text}</p>
    </div>
  )
}

export function BoardCard({
  card,
  latest,
  match,
  visible,
  selected,
  view,
  open,
  save,
  tabIndex,
  command,
  connected,
  notify,
  editingTitle,
  titleFinished,
  createTask,
}: {
  card: CardData
  latest?: LatestMessage
  match?: HybridHit
  visible: CardData[]
  selected: boolean
  view: ViewPreferences
  open({ id }: { id: string }): void
  save({ patch }: { patch: unknown }): Promise<boolean>
  tabIndex: number
  command: Command
  connected: boolean
  notify({ text }: { text: string }): void
  editingTitle: boolean
  titleFinished(): void
  createTask({ column, parent }: { column: string; parent?: string }): void
}) {
  const [height, setHeight] = useState<number | null>(null), parent = visibleParent({
    card,
    visible,
  })
  const activity = agentActivity({ card })

  return (
    <article
      className={`card ${card.parentId ? 'subtask' : ''} ${selected ? 'selected' : ''} ${view.cardColors ? `accent-${card.column}` : ''}`}
      style={{
        height: height ?? view.cardHeights[card.id] ?? view.cardHeight,
        minWidth: VIEW_SIZE_LIMITS.cardWidth.min,
        minHeight: VIEW_SIZE_LIMITS.cardHeight.min,
      }}
      onClick={e => {
        if (e.target instanceof Element && !e.target.closest('a, button, input, textarea, [role="separator"]') && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected}
      onDragStart={e => {
        e.stopPropagation(); e.dataTransfer.setData('application/pnyx-task', card.id)
      }}
    >
      <div className="row between">
        <span className="workspace">{card.workspace}</span>
        <Harness card={card} />
      </div>
      <SettingChips settings={card.settings} />
      <div className="card-content">
        <InlineTitle
          value={card.title}
          label={`Rename task ${card.title}`}
          startEditing={editingTitle}
          save={({ title }) => command({ name: 'task', args: ['rename', card.id, `--title=${title}`, '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()] }).then(() => titleFinished())}
        />
        <Button
          className="card-open"
          aria-label={`Open conversation for ${card.title}`}
          onClick={() => open({ id: card.id })}
          data-card={card.id}
          data-key-scope="board"
          tabIndex={tabIndex}
        >
          <span>Open conversation</span>
        </Button>
        {parent && (
          <Button className="parent" onClick={() => open({ id: parent.id })}>
            <Icon name="parent" size={13} />
            {parent.title}
          </Button>
        )}
        {!parent && card.parentId && <span className="muted small">Child task</span>}
        {needsAgent({ card }) && <Button className="start" onClick={() => open({ id: card.id })}>Start worker</Button>}
        {card.attention.slice(0, 1).map(a => <div key={a.key} className="request">{a.text ?? a.kind}</div>)}
        {match?.snippets[0] && <p className="search-match">{match.snippets[0].snippet}</p>}
        {latest && <LastMessage message={latest} />}
        <Tags tags={card.tags} />
        <Links links={card.links} />
        {visible.some(c => c.parentId === card.id) && (
          <span className="muted small">
            {visible.filter(c => c.parentId === card.id).length}
            {' '}
            child tasks
          </span>
        )}
        <div className="row wrap task-actions">
          <Button
            disabled={!connected}
            onClick={() => void command({ name: 'hydra', args: ['send', '--task', card.id, '--event-id', crypto.randomUUID()] }).then(() => notify({ text: 'Task posted in Hydra’s chat' }))
              .catch(e => notify({ text: e.message }))}
          >Send to Hydra
          </Button>
          <Button
            disabled={!connected}
            onClick={() => void command({ name: 'hydra', args: ['send', '--task', card.id, '--action', 'worker', '--event-id', crypto.randomUUID()] }).then(() => notify({ text: 'Worker request posted in Hydra’s chat' }))
              .catch(e => notify({ text: e.message }))}
          >Create a worker
          </Button>
          {!card.parentId && (
            <Button
              disabled={!connected}
              onClick={() => createTask({ column: card.column, parent: card.id })}
            >+ Subtask
            </Button>
          )}
        </div>
      </div>
      <div className="card-footer">
        <span
          className={activity ? `agent-activity activity-${activity}` : undefined}
          title={card.status?.note}
        >
          {activity ? <i aria-hidden="true" /> : <Icon name={card.column} size={13} />}
          {taskLabel({ card, focus: traces({ view, card: card.id }).focus })}
        </span>
        {card.manualColumn ? (
          <span title="Manual placement">
            <Icon name="pin" size={13} />
            Pinned
          </span>
        ) : <span>{card.replies?.at(-1) ? receiptLabel({ state: card.replies.at(-1)!.state }) : 'Automatic'}</span>}
      </div>
      <Resize
        label={`Resize card ${card.title}`}
        axis="y"
        value={view.cardHeights[card.id] ?? view.cardHeight}
        min={VIEW_SIZE_LIMITS.cardHeight.min}
        max={VIEW_SIZE_LIMITS.cardHeight.max}
        onPreview={({ value }) => setHeight(value)}
        onCommit={({ value: n }) => save({ patch: { cardHeights: { [card.id]: n } } })}
      />
    </article>
  )
}
