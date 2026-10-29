import { AgentDetails } from '#web-workers/agent-details.tsx'
import { answerPrompt } from '#workers/answers.ts'
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { ReminderEditor, ReminderLabel, type ReminderDraft } from './reminder.tsx'
import type { ViewPreferences } from '#preferences/model.ts'
import type { Card as CardData, SavedLabelColor } from '#tasks/model.ts'
import { Label } from '#web-shared/ui/label.tsx'
import type { LatestMessage } from '#hydra/transcripts-read.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { CardTitle } from './card-title.tsx'
import { TaskEditor, type TaskDraft } from './task-editor.tsx'
import { useCardHeight } from './card-height.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { projectTitle } from '#web-projects/view.ts'
import { cardState } from './view.ts'
import { currentState, ownerDecisions, statusLabel } from '#tasks/card-status.ts'
import { Tabs, panelId, tabId } from '#web-shared/ui/tabs.tsx'
import { hasTaskQuestion, TaskQuestion } from './task-question.tsx'
import { harnessName } from '#web-workers/view.ts'
import { Resize } from '#web-shared/ui/resize.tsx'

import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { WorkingDots } from '#web-hydra/streaming.tsx'
import { openAsks } from '#tasks/questions.ts'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { TaskReport } from '#web-investigations/task-report.tsx'
import { HoverActions } from '#web-shared/ui/hover-actions.tsx'
import { ActionBubble } from '#web-hydra/action-bubble.tsx'
import type { PnyxLookup } from '#web-hydra/pnyx-action.ts'
import type { CurrentAction } from '#hydra/calls.ts'

const OPEN_SHARE = 0.5

const STATE_SOURCE = {
  note: "Worker's note",
  progress: 'Worker progress report',
}

// With questions open, Intent and Current state sit below them; this row jumps there.
function ContextIndex({
  questions,
  intent,
  state,
}: {
  questions: number
  intent: boolean
  state: boolean
}) {
  const jump = ({
    event,
    section,
  }: {
    event: MouseEvent<HTMLButtonElement>
    section: string
  }) => {
    event.stopPropagation()
    event.currentTarget.closest('.card-panel')?.querySelector<HTMLElement>(section)
      ?.scrollIntoView({ block: 'start' })
  }

  return (
    <nav className="card-index" aria-label="On this card">
      <span>{questions === 1 ? '1 question' : `${questions} questions`}</span>
      {intent && (
        <Button
          className="quiet"
          onClick={event => jump({
            event,
            section: '.card-intent',
          })}
        >Intent
        </Button>
      )}
      {state && (
        <Button
          className="quiet"
          onClick={event => jump({
            event,
            section: '.card-current-state',
          })}
        >Current state
        </Button>
      )}
    </nav>
  )
}

function LastMessage({ message }: { message: LatestMessage }) {
  return (
    <div className="last-message">
      <strong>Current state</strong>
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
  recoverSelection,
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
    pointer,
    focusUpdates,
  }: {
    id: string
    pointer?: boolean
    focusUpdates?: boolean
  }): Promise<boolean>
  onEdit(): void
  recoverSelection({ id }: { id: string }): void
  tabIndex: number
  command: Command
  connected: boolean
  children?: ReactNode
  answer({ card }: { card: CardData }): void
}) {
  const element = useRef<HTMLElement>(null)
  const briefId = useId()
  const [
    briefOpen,
    setBriefOpen,
  ] = useState(false)
  const [
    editing,
    setEditing,
  ] = useState<{
    version: number
    draft?: TaskDraft
  } | null>(null)
  const editVersion = useRef(0)
  // A refused save reopens the editor from an older render, so it reads selection here.
  const isSelected = useRef(selected)
  isSelected.current = selected
  const refocusTitle = useRef(false)
  useEffect(
    () => {
      if (!editing && refocusTitle.current) {
        refocusTitle.current = false
        element.current?.querySelector<HTMLElement>('.card-open')?.focus({ preventScroll: true })
      }
    },
    [editing],
  )

  const edit = ({ draft }: { draft?: TaskDraft } = {}) => {
    onEdit(); setBriefOpen(true)
    setEditing({
      version: ++editVersion.current,
      draft,
    })

    if (!isSelected.current) {
      void open({
        id: card.id,
        focusUpdates: false,
      })
    }
  }

  useKeyAction({
    id: 'card.edit',
    handler: ({ context }) => {
      if (context.target.closest('.card') !== element.current || !connected || editing) {
        return false
      }

      edit()

      return true
    },
  })

  const [
    preview,
    setPreview,
  ] = useState<number | null>(null)
  const tabsId = useId()
  const [
    tab,
    setTab,
  ] = useState<'context' | 'activity'>('context')
  useEffect(
    () => {
      if (!selected) {
        setTab('context')
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
  ] = useState<{
    version: number
    draft?: ReminderDraft
  } | null>(null)
  const reminderVersion = useRef(0)
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
  const statusText = statusLabel({ status })
  const tint = labelColors?.find(entry => entry.label === card.project)
    ?? labelColors?.find(entry => card.tags.includes(entry.label))
  const said = currentState({ card })
  const stateSource = said ? STATE_SOURCE[said.source] : 'Agent update'
  const factual = said ? {
    role: 'assistant' as const,
    text: said.text,
    at: said.at,
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
  // The same list the status word counts, so the box and the status always agree.
  const waiting = ownerDecisions({ card }).filter(decision => !decision.answer)
  const question = waiting[0]?.text
  const questionLabel = waiting.length > 1 ? `${waiting.length} questions` : 'Question'

  const tags = card.tags.filter(tag => tag !== card.project)
  const labels = tags.length > 0 && (
    <div className="card-labels">
      {tags.map(tag => (
        <Label key={tag} label={tag} colors={labelColors} />
      ))}
    </div>
  )
  const panel = ({ id }: { id: 'context' | 'activity' }) => ({
    role: 'tabpanel',
    id: panelId({
      prefix: tabsId,
      id,
    }),
    'aria-labelledby': tabId({
      prefix: tabsId,
      id,
    }),
    hidden: tab !== id,
    tabIndex: 0,
    className: 'card-panel',
  })

  // The brief lives in Activity; the title still shows or hides it, opening the card first.
  const toggleBrief = () => {
    const show = tab !== 'activity' || !briefOpen
    setTab('activity'); setBriefOpen(show)

    if (!isSelected.current) {
      void open({
        id: card.id,
        focusUpdates: false,
      })
    }
  }

  return (
    <article
      ref={element}
      className={`card ${selected ? 'selected' : ''}`}
      style={{
        // Natural height avoids animating a newly mounted card from zero.
        height: bounds.measured ? Math.max(
          bounds.minimum,
          Math.min(
            bounds.maximum,
            preview ?? height,
          ),
        ) : undefined,
      }}
      data-task={card.id}
      data-tab={selected ? tab : undefined}
      data-label-color={tint?.color}
      onClick={e => {
        const control = e.target instanceof Element
          && e.target.closest('a, button, input, textarea, form, summary, .menu, .resize')

        if (!control && !window.getSelection()?.toString()) {
          open({
            id: card.id,
            pointer: true,
          })
        }
      }}
      draggable={connected && !selected && !reminding && !editing}
      onDragStart={e => {
        if (e.target instanceof Element && e.target.closest('button, .resize, form')) {
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
          {card.project && (
            <Label
              project
              label={card.project}
              text={projectTitle({ project: card.project })}
              colors={labelColors}
            />
          )}
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
          {!editing && (
            <CardTitle
              title={card.title}
              briefOpen={selected && tab === 'activity' && briefOpen}
              toggleBrief={toggleBrief}
              open={() => void open({ id: card.id })}
              aria-controls={selected ? briefId : undefined}
              data-card={card.id}
              data-key-scope="hydra"
              tabIndex={tabIndex}
            />
          )}
          <HoverActions anchor={element}>
            <Tooltip content="Edit title and brief">
              <Button
                aria-label="Edit title and brief"
                disabled={!connected || !!editing}
                onClick={event => {
                  event.stopPropagation(); edit()
                }}
              ><Icon name="renamed" size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Remind">
              <Button
                aria-label="Remind"
                disabled={!connected}
                onClick={() => setReminding({ version: ++reminderVersion.current })}
              ><Icon name="reminder" size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Hide">
              <Button
                aria-label="Hide"
                disabled={!connected}
                onClick={async () => {
                  const wasSelected = selected

                  try {
                    const saving = command({
                      name: 'task',
                      args: [
                        'hide',
                        card.id,
                        '--event-id',
                        crypto.randomUUID(),
                      ],
                    })

                    if (wasSelected) {
                      await open({ id: card.id })
                    }

                    await saving
                  } catch (error) {
                    if (wasSelected) {
                      recoverSelection({ id: card.id })
                    }

                    notify({ text: (error as Error).message })
                  }
                }}
              ><Icon name="review" size={15} />
              </Button>
            </Tooltip>
          </HoverActions>
        </div>
        {editing && (
          <TaskEditor
            key={editing.version}
            card={card}
            draft={editing.draft}
            command={command}
            close={() => {
              refocusTitle.current = true; setEditing(null)
            }}
            failed={({
              draft,
              error,
            }) => {
              if (editVersion.current === editing.version) {
                edit({ draft })
              }

              notify({ text: error.message })
            }}
          />
        )}
        {selected && (
          <>
            <Tabs
              className="card-tabs"
              prefix={tabsId}
              label="Card sections"
              selected={tab}
              select={({ id }) => setTab(id === 'activity' ? 'activity' : 'context')}
              tabs={[
                {
                  id: 'context',
                  label: 'Context',
                },
                {
                  id: 'activity',
                  label: 'Activity',
                },
              ]}
            />
            <div {...panel({ id: 'context' })}>
              {card.copy?.state === 'flagged' && <CollapsibleText className="copy-warning" text={card.copy.reason ?? ''} />}
              {waiting.length > 0 && (card.goal || factual) && (
                <ContextIndex
                  questions={waiting.length}
                  intent={!!card.goal}
                  state={!!factual}
                />
              )}
              {hasTaskQuestion({ card }) && (
                <TaskQuestion
                  card={card}
                  command={command}
                  notify={notify}
                  answer={answer}
                />
              )}
              {card.goal && (
                <section className="card-section card-intent" aria-label="Intent">
                  <h3 className="eyebrow">Intent</h3>
                  <CollapsibleText text={card.goal} />
                </section>
              )}
              {factual && (
                <section className="card-section card-current-state" aria-label="Current state">
                  <h3 className="eyebrow">Current state</h3>
                  <CollapsibleText text={factual.text} />
                  <p className="muted small">{stateSource}, {relativeTime({
                    at: factual.at,
                    now,
                  })}
                  </p>
                </section>
              )}
              {labels}
              <CardLinks links={card.links} expanded />
              <ReminderLabel card={card} />
            </div>
            <div {...panel({ id: 'activity' })}>
              {!!card.ask?.length && (
                <section className="card-section" aria-label="Your words">
                  <h3 className="eyebrow">Your words</h3>
                  {card.ask.map(entry => (
                    <div key={`${entry.at}-${entry.message ?? ''}`} className="card-owner-words">
                      <CollapsibleText text={entry.text} />
                      <p className="muted small">{relativeTime({
                        at: entry.at,
                        now,
                      })}
                      </p>
                    </div>
                  ))}
                </section>
              )}
              <section className="card-instructions" aria-label="Instructions">
                <Button
                  className="quiet card-instructions-toggle"
                  aria-expanded={briefOpen}
                  aria-controls={briefId}
                  onClick={() => setBriefOpen(value => !value)}
                ><Icon name="chevron_right" size={13} />Hydra's instructions to the worker
                </Button>
                <div id={briefId} className="card-brief" hidden={!briefOpen}>
                  {card.brief?.trim()
                    ? <CollapsibleText text={card.brief} />
                    : <p className="muted">{card.automaticTask ? 'Automatic tasks have no brief.' : 'No brief yet. The pencil adds one.'}</p>}
                </div>
              </section>
              <TaskReport
                card={card}
                command={command}
                connected={connected}
              />
              {card.launch?.dispatch && <CollapsibleText className="muted small" text={card.launch.dispatch} />}
            </div>
          </>
        )}
        {!selected && card.copy?.state === 'flagged' && (
          <Tooltip content={card.copy.reason}><span className="copy-warning" tabIndex={0}>copy not cleaned</span></Tooltip>
        )}
        {!selected && question && (
          <div className="card-question" aria-label="Task question">
            <strong className="eyebrow">{questionLabel}</strong>
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
                draft={reminding.draft}
                close={() => setReminding(null)}
                submitted={() => {
                  setReminding(null)

                  if (selected) {
                    setTab('context')
                  }
                }}
                recover={({ draft }) => {
                  if (reminderVersion.current === reminding.version) {
                    setReminding({
                      ...reminding,
                      draft,
                    })
                  }

                  notify({ text: draft.error })
                }}
              />
            )}
          </div>
        )}
        {!selected && (
          <>
            {labels}
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
