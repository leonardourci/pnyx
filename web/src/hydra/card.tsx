import { answerPrompt } from '../../../src/core/answer.ts'
import { QueueEditor, QueueLabel, WorkerQueue } from './queue.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel } from './reminder.tsx'
import type { Card as CardData, HydraState, SavedLabelColor, ViewPreferences } from '../../../src/core/model.ts'
import { Label } from '../components/ui/label.tsx'
import type { LatestMessage } from '../../../src/thread/read.ts'
import { Markdown } from '../components/ui/markdown.tsx'
import { InlineTitle } from '../components/ui/inline-title.tsx'
import { useCardHeight } from './card-height.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import { taskUpdates } from '../../../src/thread/task.ts'
import type { Command } from './connection.ts'
import { Menu } from '../components/ui/menu.tsx'
import { CopyId } from '../components/ui/copy-id.tsx'
import { HideAfter } from './hide-after.tsx'
import { useStartRequest } from './start-request.ts'
import { cardState, projectTitle, harnessName } from './view.ts'
import { Resize } from '../components/ui/resize.tsx'

import { Tooltip } from '../components/ui/tooltip.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { HoverActions } from '../components/ui/hover-actions.tsx'

const OPEN_SHARE = 0.5

function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message">
      <strong>Agent update</strong>
      <Markdown text={message.text} />
    </div>
  )
}

export function HydraCard({
  card,
  state,
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
  answer,
  doneAfterHours,
  notify,
}: {
  card: CardData
  state: HydraState
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
  answer({ card }: { card: CardData }): void
}) {
  const [
    queueing,
    setQueueing,
  ] = useState(false)
  const element = useRef<HTMLElement>(null)
  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
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
    renaming,
    setRenaming,
  ] = useState(false)
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
    start,
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

  const agentHost = card.agent?.host === 'pnyx' ? 'Pnyx' : ''
  const agentRoute = card.terminal?.tty ? 'terminal' : agentHost
  const created = card.createdAt || card.statusLog?.[0]?.at
  const request = card.permissions?.find(request => request.status === 'pending')
  const attention = card.attention.find(request => request.blocking && !request.answered)
  const canAnswer = attention && answerPrompt({
    card,
    request: attention,
  })
  const question = request?.questions?.map(question => question.question).join(' ')
    || attention?.text || (card.status?.state === 'needs_you' ? card.status.note : '')

  return (
    <article
      ref={element}
      className={`card ${selected ? 'selected' : ''} ${queueing ? 'queueing' : ''}`}
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
      draggable={connected && !selected && !reminding && !queueing}
      onDragStart={e => {
        if (e.target instanceof Element && e.target.closest('.resize')) {
          e.preventDefault()

          return
        }

        e.stopPropagation(); e.dataTransfer.setData(
          'application/pnyx-task',
          card.id,
        )
      }}
    >
      <HoverActions anchor={element}>
        {!card.automaticTask && (
          <Tooltip content="Remind"><Button aria-label="Remind" disabled={!connected} onClick={() => setReminding(true)}><Icon name="reminder" size={15} /></Button></Tooltip>
        )}
        <Tooltip content="Copy ID"><CopyId id={card.id} notify={notify} icon /></Tooltip>
        <Tooltip content="More options">
          <Menu label={`Card menu for ${card.title}`}>
            {!card.automaticTask && (
              <Button disabled={!connected} onClick={() => setReminding(true)}><Icon name="reminder" size={15} />Remind me…</Button>
            )}
            {!firstmate && !card.automaticTask && !card.sessionIds?.length && !card.doneAt && (
              <Button disabled={!connected} onClick={() => setQueueing(true)}>{card.queue ? 'Edit worker queue…' : 'Queue behind a worker…'}</Button>
            )}
            <Button
              onClick={() => {
                setRenaming(true)

                if (!selected) {
                  open({ id: card.id })
                }
              }}
            ><Icon name="rename" size={15} />Rename task
            </Button>
            {!card.automaticTask && (
              <Button
                disabled={!connected}
                onClick={async () => {
                  try {
                    await command({
                      name: 'task',
                      args: [
                        card.hidden ? 'unhide' : 'hide',
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
              ><Icon name="review" size={15} />{card.hidden ? 'Bring back to Hydra' : 'Hide from Hydra'}
              </Button>
            )}
            <Button disabled={!connected || busy} onClick={card.agent ? resume : start}><Icon name="in_progress" size={15} />{card.agent ? 'Resume' : 'Start'}</Button>
            <HideAfter
              card={card}
              command={command}
              connected={connected}
              notify={notify}
            />
          </Menu>
        </Tooltip>
      </HoverActions>
      <div className="card-content">
        <div className="card-state">
          <span className={`agent-activity activity-${status.kind}`}><i aria-hidden="true" />{statusText}</span>
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
              content={[
                harnessName({ provider: card.agent.provider }),
                agentRoute,
              ].filter(Boolean).join(' · ')}
            >
              <span className="card-agent" tabIndex={0} aria-label={harnessName({ provider: card.agent.provider })}>
                <Icon name={card.agent.provider} />
              </span>
            </Tooltip>
          )}

        </div>
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
        {renaming && selected && (
          <>
            <InlineTitle
              value={card.title}
              label="Task title"
              startEditing
              finished={() => setRenaming(false)}
              save={async ({ title }) => {
                await command({
                  name: 'task',
                  args: [
                    'rename',
                    card.id,
                    '--title',
                    title,
                    '--event-id',
                    crypto.randomUUID(),
                  ],
                })
                setRenaming(false)
              }}
            />
            <Input
              aria-label="Task project label"
              defaultValue={card.project ?? ''}
              placeholder="Project label"
              onBlur={async event => {
                if (event.target.value !== (card.project ?? '')) {
                  try {
                    await command({
                      name: 'task',
                      args: [
                        'rename',
                        card.id,
                        '--project',
                        event.target.value,
                        '--event-id',
                        crypto.randomUUID(),
                      ],
                    })
                  } catch (error) {
                    notify({ text: (error as Error).message })
                  }
                }
              }}
            />
          </>
        )}
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
        {card.copy?.state === 'flagged' && (
          <Tooltip content={card.copy.reason}><span className="copy-warning" tabIndex={0}>copy not cleaned</span></Tooltip>
        )}
        {question && (
          <div className="card-question" aria-label="Task question">
            <strong className="eyebrow">Question</strong>
            <p>{question}</p>
            <Button
              variant="primary"
              onClick={() => {
                if (request || canAnswer) {
                  if (!selected) {
                    open({ id: card.id })
                  }

                  requestAnimationFrame(() => element.current?.querySelector<HTMLElement>('.ask button')?.focus())

                  return
                }

                answer({ card })
              }}
            >Answer
            </Button>
          </div>
        )}
        <QueueLabel card={card} state={state} open={open} />
        <WorkerQueue card={card} state={state} open={open} />
        {(!selected || reminding || queueing) && (
          <div className="card-rest">
            {queueing && (
              <QueueEditor
                card={card}
                state={state}
                command={command}
                connected={connected}
                close={() => setQueueing(false)}
              />
            )}
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
        <CardLinks links={card.links} expanded={selected} />
        <ReminderLabel card={card} />
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
