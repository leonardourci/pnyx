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
import { useCardHeight, useTypingGrowth } from './card-height.ts'
import { clickTogglesCard } from './card-click.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { projectTitle } from '#web-projects/view.ts'
import { cardState, TASK_DRAG } from './view.ts'
import { currentState, statusLabel, waitingQuestions } from '#tasks/card-status.ts'
import { ownerQuestions } from '#tasks/questions.ts'
import { Tabs, panelId, tabId } from '#web-shared/ui/tabs.tsx'
import { hasTaskQuestion, TaskQuestion } from './task-question.tsx'
import { harnessName } from '#web-workers/view.ts'
import { Resize } from '#web-shared/ui/resize.tsx'

import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { WorkingDots } from '#web-hydra/streaming.tsx'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { TaskReport } from '#web-investigations/task-report.tsx'
import { HoverActions } from '#web-shared/ui/hover-actions.tsx'
import type { CurrentAction } from '#hydra/calls.ts'
import type { DoneAfterHours } from '#settings/model.ts'
import { draggableItem } from '#web-shared/ui/drag.ts'

const OPEN_SHARE = 0.5
// A closed card shows this many whole lines of its update beyond the one it always keeps.
const CLOSED_EXTRA_LINES = 2

const STATE_SOURCE = {
  note: "Worker's status note",
  progress: "Worker's progress report",
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
    const panel = event.currentTarget.closest('.card-panel')
    const target = panel?.querySelector(section)

    if (!panel || !target) {
      return
    }

    // Only the panel scrolls; scrollIntoView would also move the column and the Hydra.
    panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top
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
  state,
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
}: {
  card: CardData
  state?: import('#app/model.ts').HydraState
  action?: CurrentAction
  labelColors?: SavedLabelColor[]
  doneAfterHours?: DoneAfterHours
  notify({ text }: { text: string }): void
  latest?: LatestMessage
  selected: boolean
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  open({
    id,
    pointer,
    focusPanel,
  }: {
    id: string
    pointer?: boolean
    focusPanel?: boolean
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
        focusPanel: false,
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
  const typingGrowth = useTypingGrowth({ element })
  const saved = selected ? view.cardHeights[card.id] : view.closedCardHeights[card.id]
  const closedHeight = bounds.minimum + CLOSED_EXTRA_LINES * bounds.line
  const defaultHeight = selected ? Math.round(bounds.available * OPEN_SHARE) : closedHeight
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
    connected,
    state,
    action,
    now,
  })
  const working = status.kind === 'working'
  const statusText = statusLabel({ status })
  const tint = labelColors?.find(entry => entry.label === card.project)
    ?? labelColors?.find(entry => card.tags.includes(entry.label))
  const said = currentState({ card })
  const stateSource = said ? STATE_SOURCE[said.source] : "Agent's last message"
  const factual = said ? {
    role: 'assistant' as const,
    text: said.text,
    at: said.at,
  } : !card.tracking && latest?.role === 'assistant' ? latest : undefined

  const created = card.createdAt || card.statusLog?.[0]?.at
  const waiting = waitingQuestions({ card })
  // A question whose answer is still on its way shows only when nothing else waits.
  const question = waiting[0] ?? ownerQuestions({ card })[0]
  const request = question?.permission
  const attention = question?.attention
  const asked = question?.ask
  const canAnswer = attention && answerPrompt({
    card,
    request: attention,
  })
  const delivery = question?.delivery
  const answerSaved = delivery && delivery.state !== 'delivered'
  let questionLabel = answerSaved ? 'Answer saved' : 'Question'

  if (waiting.length > 1) {
    questionLabel = `${waiting.length} questions`
  }

  const answerLabel = answerSaved ? 'Review answer' : 'Answer'
  const deliveryText = delivery?.state === 'failed'
    ? 'Delivery failed. Open the task to send the answer again.'
    : 'Waiting to reach the worker.'

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
  // Activity mounts only while it shows, so a hidden one reads no history or report; Context stays mounted to keep draft answers.
  const showsActivity = tab === 'activity'
  // The title opens the brief, which exists only while Activity shows; before that it controls the Activity panel.
  const briefControl = showsActivity ? briefId : panelId({
    prefix: tabsId,
    id: 'activity',
  })

  // The brief lives in Activity; the title still shows or hides it, opening the card first.
  const toggleBrief = () => {
    const show = tab !== 'activity' || !briefOpen
    setTab('activity'); setBriefOpen(show)

    if (!isSelected.current) {
      void open({
        id: card.id,
        focusPanel: false,
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
            preview ?? Math.min(
              Math.max(
                bounds.available,
                height,
              ),
              height + typingGrowth,
            ),
          ),
        ) : undefined,
      }}
      data-task={card.id}
      data-tab={selected ? tab : undefined}
      data-label-color={tint?.color}
      onClick={e => {
        if (clickTogglesCard({
          card: e.currentTarget,
          target: e.target instanceof Element ? e.target : null,
          selecting: !!window.getSelection()?.toString(),
        })) {
          open({
            id: card.id,
            pointer: true,
          })
        }
      }}
      {...draggableItem({
        type: TASK_DRAG,
        id: card.id,
        enabled: connected && !selected && !reminding && !editing,
        skip: 'button, .resize, form',
      })}
    >
      <div className="card-content">
        <div className="card-state">
          <Tooltip content={status.details}>
            <span className={`agent-activity activity-${status.kind}`} aria-label={statusText}>
              {working ? <WorkingDots /> : <i aria-hidden="true" />}
              {statusText}
            </span>
          </Tooltip>
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
              briefOpen={selected && showsActivity && briefOpen}
              toggleBrief={toggleBrief}
              open={() => void open({ id: card.id })}
              aria-controls={selected ? briefControl : undefined}
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
              {waiting.length > 0 && (card.intent || factual) && (
                <ContextIndex
                  questions={waiting.length}
                  intent={!!card.intent}
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
              {card.intent && (
                <section className="card-section card-intent" aria-label="Intent">
                  <h3 className="eyebrow">Intent</h3>
                  <CollapsibleText text={card.intent} />
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
              {showsActivity && (
                <>
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
                  {children}
                </>
              )}
            </div>
          </>
        )}
        {!selected && card.copy?.state === 'flagged' && (
          <Tooltip content={card.copy.reason}><span className="copy-warning" tabIndex={0}>copy not cleaned</span></Tooltip>
        )}
        {!selected && question && (
          <div className="card-question" aria-label="Task question">
            <strong className="eyebrow">{questionLabel}</strong>
            <CollapsibleText text={question.text} />
            {answerSaved && <p className="muted small">{deliveryText}</p>}
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
            >{answerLabel}
            </Button>
          </div>
        )}
        {(!selected || reminding) && (
          <div className="card-rest">
            {view.lastMessageOnCards && !selected && (
              factual ? <LastMessage message={factual} /> : <p className="last-message">No current state yet.</p>
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
