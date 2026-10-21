import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel } from './reminder.tsx'
import type { Card as CardData, SavedLabelColor, ViewPreferences } from '../../../src/core/model.ts'
import { Label } from '../components/ui/label.tsx'
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
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { Resize } from '../components/ui/resize.tsx'

const MIN_UPDATES_HEIGHT = 80

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
  labelColors,
  latest,
  selected,
  view,
  save,
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
  labelColors?: SavedLabelColor[]
  doneAfterHours?: number
  notify({ text }: { text: string }): void
  latest?: LatestMessage
  selected: boolean
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  open({ id }: { id: string }): void
  tabIndex: number
  command: Command
  connected: boolean
  children?: ReactNode
}) {
  const element = useRef<HTMLElement>(null)
  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const [
    minimum,
    setMinimum,
  ] = useState<number>(VIEW_SIZE_LIMITS.cardHeight.min)
  const [
    limit,
    setLimit,
  ] = useState<number>(VIEW_SIZE_LIMITS.cardHeight.max)
  const height = Math.max(
    minimum,
    Math.min(
      limit,
      view.cardHeights[card.id] ?? 480,
    ),
  )
  useLayoutEffect(
    () => {
      const card = element.current
      const pane = card?.closest('.column-cards')

      if (!selected || !card || !pane) {
        return
      }

      const measure = () => {
        const style = getComputedStyle(pane)
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        const available = Math.floor(pane.clientHeight - padding)
        const updates = card.querySelector<HTMLElement>('.task-updates')
        const cardStyle = getComputedStyle(card)
        const frame = updates ? updates.getBoundingClientRect().top - card.getBoundingClientRect().top
        + parseFloat(cardStyle.paddingBottom) + parseFloat(cardStyle.borderBottomWidth) : 0
        const readable = Math.min(
          VIEW_SIZE_LIMITS.cardHeight.max,
          Math.max(
            VIEW_SIZE_LIMITS.cardHeight.min,
            Math.ceil(frame + MIN_UPDATES_HEIGHT),
          ),
        )
        setMinimum(Math.min(
          readable,
          available,
        ))
        setLimit(Math.max(
          Math.min(
            readable,
            available,
          ),
          Math.min(
            VIEW_SIZE_LIMITS.cardHeight.max,
            available,
          ),
        ))
      }

      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(pane)
      observer.observe(card)
      const detail = card.querySelector('.detail')

      if (detail) {
        observer.observe(detail)
      }

      return () => observer.disconnect()
    },
    [selected],
  )
  const [
    reminding,
    setReminding,
  ] = useState(false)
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        30_000,
      )

      return () => clearInterval(timer)
    },
    [],
  )
  const {
    resume,
    busy,
  } = useStartRequest({
    card,
    firstmate,
    command,
    notify,
  })
  const status = cardState({
    card,
    hours: doneAfterHours,
    now,
  })
  const tint = labelColors?.find(entry => entry.label === card.project)
    ?? labelColors?.find(entry => card.tags.includes(entry.label))
  const update = taskUpdates({ card }).at(-1)
  const factual = update ? {
    role: 'assistant' as const,
    text: update.text,
    at: update.at,
  } : !card.tracking && latest?.role === 'assistant' ? latest : undefined

  return (
    <article
      ref={element}
      className={`card ${selected ? 'selected' : ''}`}
      style={selected ? { height: `min(${preview ?? height}px, 100cqh)` } : undefined}
      data-task={card.id}
      data-label-color={tint?.color}
      onClick={e => {
        if (e.target instanceof Element && !e.target.closest('a, button, input, textarea, form, .detail, .menu, .resize') && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected && !selected && !reminding}
      onDragStart={e => {
        e.stopPropagation(); e.dataTransfer.setData(
          'application/pnyx-task',
          card.id,
        )
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
      {(card.project || card.tags.length > 0) && (
        <div className="card-labels">
          {card.project && (
            <Label
              project
              label={card.project}
              text={projectTitle({ project: card.project })}
              colors={labelColors}
            />
          )}
          {card.tags.filter(tag => tag !== card.project).map(tag => (
            <Label key={tag} label={tag} colors={labelColors} />
          ))}
        </div>
      )}
      <Button
        className="card-open"
        aria-label={`Open task ${card.title}`}
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
      {selected && (
        <Resize
          label="Resize card"
          axis="y"
          value={height}
          min={minimum}
          max={limit}
          onPreview={({ value }) => setPreview(value)}
          onCommit={({ value }) => save({ patch: { cardHeights: { [card.id]: value } } })}
        />
      )}
    </article>
  )
}
