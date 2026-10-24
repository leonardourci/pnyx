import { AgentDetails } from './agent-details.tsx'
import { answerPrompt } from '../../../src/core/answer.ts'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel } from './reminder.tsx'
import type { Card as CardData, SavedLabelColor, ViewPreferences } from '../../../src/core/model.ts'
import { Label } from '../components/ui/label.tsx'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { CollapsibleText } from '../components/ui/disclosure.tsx'
import { EditableTitle } from '../components/ui/editable-title.tsx'
import { useCardHeight } from './card-height.ts'
import { Button } from '../components/ui/controls.tsx'
import { taskUpdates } from '../../../src/thread/task.ts'
import type { Command } from './connection.ts'
import { cardState, projectTitle, harnessName } from './view.ts'
import { Resize } from '../components/ui/resize.tsx'

import { Tooltip } from '../components/ui/tooltip.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { WorkingDots } from '../components/ui/streaming.tsx'
import { askWording, openAsks } from '../../../src/core/asks.ts'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { TaskReport } from './task-report.tsx'
import { HoverActions } from '../components/ui/hover-actions.tsx'
import { ActionBubble } from './action-bubble.tsx'
import type { PnyxLookup } from './pnyx-action.ts'
import type { CurrentAction } from '../../../src/thread/calls.ts'

const OPEN_SHARE = 0.5

function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message">
      <strong>Agent update</strong>
      <CollapsibleText text={message.text} />
    </div>
  )
}

export function HydraCard({
  card,
  labelColors,
  latest,
  selected,
  view,
  save,
  open,
  onEdit,
  tabIndex,
  command,
  connected,
  children,
  answer,
  doneAfterHours,
  notify,
  action,
  lookup,
}: {
  card: CardData
  action?: CurrentAction
  lookup: PnyxLookup
  labelColors?: SavedLabelColor[]
  doneAfterHours?: number
  notify({ text }: { text: string }): void
  latest?: LatestMessage
  selected: boolean
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  open({
    id,
    fromTitle,
  }: {
    id: string
    fromTitle?: boolean
  }): Promise<boolean>
  onEdit(): void
  tabIndex: number
  command: Command
  connected: boolean
  children?: ReactNode
  answer({ card }: { card: CardData }): void
}) {
  const element = useRef<HTMLElement>(null)
  const [
    editingTitle,
    setEditingTitle,
  ] = useState(false)

  const editTitle = () => {
    onEdit(); setEditingTitle(true)
  }

  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const metadataId = useId()
  const [
    metadataOpen,
    setMetadataOpen,
  ] = useState(false)
  useEffect(
    () => {
      if (!selected) {
        setMetadataOpen(false)
      }
    },
    [selected],
  )
  const bounds = useCardHeight({
    element,
    selected,
  })
  const saved = selected ? view.cardHeights[card.id] : view.closedCardHeights[card.id]
  const defaultHeight = selected ? Math.round(bounds.available * OPEN_SHARE) : bounds.minimum + 44
  const height = Math.max(
    bounds.minimum,
    Math.min(
      bounds.maximum,
      saved ?? defaultHeight,
    ),
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
  const status = cardState({
    card,
    hours: doneAfterHours,
    now,
  })
  const working = status.kind === 'working'
  const statusText = status.kind === 'asks' ? 'Needs you' : status.text.replace(
    /^./,
    c => c.toUpperCase(),
  )
  const tint = labelColors?.find(entry => entry.label === card.project)
    ?? labelColors?.find(entry => card.tags.includes(entry.label))
  const update = taskUpdates({ card }).at(-1)
  const factual = update ? {
    role: 'assistant' as const,
    text: update.text,
    at: update.at,
  } : !card.tracking && latest?.role === 'assistant' ? latest : undefined

  const created = card.createdAt || card.statusLog?.[0]?.at
  const request = card.permissions?.find(request => request.status === 'pending')
  const attention = card.attention.find(request => request.blocking && !request.answered)
  const canAnswer = attention && answerPrompt({
    card,
    request: attention,
  })
  const asked = openAsks({
    card,
    audience: 'owner',
  })[0]
  const question = request?.questions?.map(question => question.question).join(' ')
    || attention?.text || (asked && askWording({ ask: asked }).question)
    || (card.status?.state === 'needs_you' ? card.status.note : '')

  const labels = (card.project || card.tags.length > 0) && (
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
  )

  const hasMetadata = !!(card.project || card.tags.length || card.links.length
    || card.reminder || card.launch?.dispatch || card.copy?.state === 'flagged')
  const metadataLabel = `${metadataOpen ? 'Hide' : 'Show'} labels and links`

  return (
    <article
      ref={element}
      className={`card ${selected ? 'selected' : ''}`}
      style={{
        height: Math.max(
          bounds.minimum,
          Math.min(
            bounds.maximum,
            preview ?? height,
          ),
        ),
      }}
      data-task={card.id}
      data-label-color={tint?.color}
      onClick={e => {
        const control = e.target instanceof Element
          && e.target.closest('a, button, input, textarea, form, summary, .menu, .resize')

        if (!control && !window.getSelection()?.toString()) {
          open({ id: card.id })
        }
      }}
      draggable={connected && !selected && !reminding && !editingTitle}
      onDragStart={e => {
        if (e.target instanceof Element && e.target.closest('button, .resize, [contenteditable="plaintext-only"]')) {
          e.preventDefault()

          return
        }

        e.stopPropagation(); e.dataTransfer.setData(
          'application/pnyx-task',
          card.id,
        )
      }}
    >
      <div className="card-content">
        <div className="card-state">
          <span className={`agent-activity activity-${status.kind}`}>
            {working
              ? <WorkingDots />
              : <i aria-hidden="true" />}
            {working
              ? (
                <ActionBubble
                  action={action}
                  since={card.workingSince}
                  lookup={lookup}
                  look="inline"
                  idle={statusText}
                />
              )
              : statusText}
          </span>
          <Tooltip content={created ? `Created ${new Date(created).toLocaleString()}` : 'Creation time not recorded'}>
            <time className="card-since" dateTime={status.at || card.updatedAt} tabIndex={0}>
              {relativeTime({
                at: status.at || card.updatedAt,
                now,
              })}
            </time>
          </Tooltip>
          {card.agent && (
            <Tooltip
              content={<AgentDetails card={card} />}
            >
              <span className="card-agent" tabIndex={0} aria-label={harnessName({ provider: card.agent.provider })}>
                <Icon name={card.agent.provider} />
              </span>
            </Tooltip>
          )}

        </div>
        <div className="card-title-row">
          <EditableTitle
            className="card-open"
            value={card.title}
            label={`Open task ${card.title}`}
            editingLabel="Task title"
            editing={editingTitle}
            edit={editTitle}
            finished={() => setEditingTitle(false)}
            aria-expanded={selected}
            disabled={!connected}
            activate={({ pointer }) => open({
              id: card.id,
              fromTitle: pointer,
            })}
            notify={notify}
            save={({ title }) => command({
              name: 'task',
              args: [
                'rename',
                card.id,
                '--title',
                title,
                '--event-id',
                crypto.randomUUID(),
              ],
            })}
            data-card={card.id}
            data-key-scope="hydra"
            tabIndex={tabIndex}
          />
          <HoverActions anchor={element}>
            <Tooltip content="Edit title">
              <Button
                aria-label="Edit task title"
                disabled={!connected}
                onClick={event => {
                  event.stopPropagation(); editTitle()
                }}
              ><Icon name="renamed" size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Remind"><Button aria-label="Remind" disabled={!connected} onClick={() => setReminding(true)}><Icon name="reminder" size={15} /></Button></Tooltip>
            <Tooltip content="Hide">
              <Button
                aria-label="Hide"
                disabled={!connected}
                onClick={async () => {
                  try {
                    await command({
                      name: 'task',
                      args: [
                        'hide',
                        card.id,
                        '--event-id',
                        crypto.randomUUID(),
                      ],
                    })

                    if (selected) {
                      open({ id: card.id })
                    }
                  } catch (error) {
                    notify({ text: (error as Error).message })
                  }
                }}
              ><Icon name="review" size={15} />
              </Button>
            </Tooltip>
          </HoverActions>
          {selected && hasMetadata && (
            <Tooltip content={metadataLabel}>
              <Button
                className="card-metadata-toggle"
                aria-label={metadataLabel}
                aria-expanded={metadataOpen}
                aria-controls={metadataId}
                onClick={() => setMetadataOpen(value => !value)}
              ><Icon name="chevron_right" size={15} />
              </Button>
            </Tooltip>
          )}
        </div>
        {!selected && labels}
        {selected && hasMetadata && (
          <div id={metadataId} className="card-metadata" hidden={!metadataOpen}>
            {labels}
            <CardLinks links={card.links} expanded />
            <ReminderLabel card={card} />
            {card.copy?.state === 'flagged' && <CollapsibleText className="copy-warning" text={card.copy.reason ?? ''} />}
            {card.launch?.dispatch && <CollapsibleText className="muted small" text={card.launch.dispatch} />}
          </div>
        )}
        {selected && (
          <TaskReport
            card={card}
            command={command}
            connected={connected}
          />
        )}
        {!selected && card.copy?.state === 'flagged' && (
          <Tooltip content={card.copy.reason}><span className="copy-warning" tabIndex={0}>copy not cleaned</span></Tooltip>
        )}
        {!selected && question && (
          <div className="card-question" aria-label="Task question">
            <strong className="eyebrow">Question</strong>
            <CollapsibleText text={question} />
            <Button
              variant="primary"
              onClick={async () => {
                if (request || canAnswer || asked) {
                  if (await open({ id: card.id })) {
                    element.current?.querySelector<HTMLElement>('.ask button, .ask textarea')?.focus()
                  }

                  return
                }

                answer({ card })
              }}
            >Answer
            </Button>
          </div>
        )}
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
        {!selected && (
          <>
            <CardLinks links={card.links} expanded={false} />
            <ReminderLabel card={card} />
          </>
        )}
      </div>
      {children}
      <Resize
        label="Resize card"
        axis="y"
        value={height}
        min={bounds.minimum}
        max={bounds.maximum}
        tabIndex={selected ? 0 : tabIndex}
        onPreview={({ value }) => setPreview(value)}
        onCommit={({ value }) => save({
          patch: { [selected ? 'cardHeights' : 'closedCardHeights']: { [card.id]: value } },
        })}
      />
    </article>
  )
}
