import { AgentDetails } from '#web-workers/agent-details.tsx'
import { memo, useEffect, useLayoutEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { ReminderEditor, ReminderLabel, type ReminderDraft } from './reminder.tsx'
import type { ViewPreferences } from '#preferences/model.ts'
import type { Card as CardData, SavedLabelColor } from '#tasks/model.ts'
import { Label } from '#web-shared/ui/label.tsx'
import type { LatestMessage } from '#hydra/transcripts-read.ts'
import { CollapsibleText } from '#web-shared/ui/disclosure.tsx'
import { CardTitle } from './card-title.tsx'
import { TaskEditor, type TaskDraft } from './task-editor.tsx'
import { OPEN_CARD_MIN_HEIGHT, OPEN_CARD_MIN_WIDTH, DEFAULT_OPEN_CARD_WIDTH, DEFAULT_OPEN_CARD_HEIGHT, DEFAULT_WINDOW_WIDTH } from '#preferences/workspace.ts'
import type { ObservedStatus } from './observed-status.ts'
import { clickTogglesCard } from './card-click.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { cardState } from './view.ts'
import { currentState, waitingQuestions } from '#tasks/card-status.ts'
import { Tabs, panelId, tabId } from '#web-shared/ui/tabs.tsx'
import { TaskQuestion } from './task-question.tsx'
import { harnessName } from '#web-workers/view.ts'
import { Resize } from '#web-shared/ui/resize.tsx'

import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { CardState } from './card-state.tsx'
import { TaskReport } from '#web-investigations/task-report.tsx'
import { HoverActions } from '#web-shared/ui/hover-actions.tsx'
import type { CurrentAction } from '#hydra/calls.ts'
import type { DoneAfterHours } from '#settings/model.ts'

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

export const HydraCard = memo(function HydraCard({
  card,
  statusOverride,
  sortScope,
  chat,
  progress,
  hasChildren,
  childrenOpen,
  toggleChildren,
  showProject = false,
  legacyProject,
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
  statusOverride?: ObservedStatus
  sortScope?: string
  chat?: ReactNode
  progress?: string
  hasChildren?: boolean
  childrenOpen?: boolean
  toggleChildren?(): void
  showProject?: boolean
  legacyProject?: boolean
  card: CardData
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
    onEdit()
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
  const [
    windowed,
    setWindowed,
  ] = useState(false)
  useLayoutEffect(
    () => {
      const card = element.current

      if (!card) {
        return
      }

      if (windowed && selected) {
        card.setAttribute(
          'popover',
          'manual',
        ); card.showPopover()
      } else {
        if (card.matches(':popover-open')) {
          card.hidePopover()
        }

        card.removeAttribute('popover')
      }
    },
    [
      windowed,
      selected,
    ],
  )
  useEffect(
    () => {
      if (!selected) {
        setWindowed(false)
      }
    },
    [selected],
  )
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
  const height = Math.max(
    OPEN_CARD_MIN_HEIGHT,
    view.cardHeights[card.id] ?? DEFAULT_OPEN_CARD_HEIGHT,
  )
  const width = view.workspace.cardWidths[card.id] ?? DEFAULT_OPEN_CARD_WIDTH
  const [
    widthPreview,
    setWidthPreview,
  ] = useState<number | null>(null)
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
  const status = statusOverride ?? cardState({
    card,
    hours: doneAfterHours,
    connected,
    action,
    now,
  })
  const tint = labelColors?.find(entry => entry.label === card.project)
    ?? labelColors?.find(entry => card.tags.includes(entry.label))
  const said = currentState({ card })
  const stateSource = said ? STATE_SOURCE[said.source] : "Agent's last message"
  const factual = said ? {
    role: 'assistant' as const,
    text: said.text,
    at: said.at,
  } : !card.tracking && latest?.role === 'assistant' ? latest : undefined

  const waiting = waitingQuestions({ card })
  const canStop = connected && card.agent?.host === 'pnyx'
    && (card.sessionActivity ?? card.activity) === 'working'

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

  return (
    <article
      ref={element}
      className={`card ${selected ? 'selected' : ''}`}
      style={{
        height: selected ? (preview ?? height) : undefined,
        width: selected ? (widthPreview ?? (windowed ? Math.max(
          width,
          DEFAULT_WINDOW_WIDTH,
        ) : width)) : undefined,
      }}
      data-task={card.id}
      data-windowed={windowed}
      onKeyDown={event => {
        if (event.key === 'Escape' && windowed) {
          event.preventDefault(); event.stopPropagation(); setWindowed(false)
        }
      }}
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
      data-sort-id={card.id}
      data-sort-kind="task"
      data-sort-scope={sortScope}
      data-sort-disabled={selected || !connected || !!reminding || !!editing}
      data-parent={card.parentId}
      data-has-children={hasChildren}

    >
      {!card.parentId && <span className="subtask-drop" data-subtask-drop aria-hidden="true">Sub-task</span>}
      <div className="card-content">
        <CardState
          card={card}
          status={status}
          now={now}
          labelColors={labelColors}
          tooltips
          compact={!selected}
          progress={progress}
          showProject={showProject}
          legacyProject={legacyProject}
        >
          {card.agent && (
            <Tooltip
              content={<AgentDetails card={card} command={command} />}
              interactive
              label="Agent details"
            >
              <span className="card-agent" tabIndex={0} aria-label={harnessName({ provider: card.agent.provider })}>
                <Icon name={card.agent.provider} />
              </span>
            </Tooltip>
          )}
        </CardState>
        <div className="card-title-row">
          {hasChildren && (
            <Button
              className="subtask-toggle"
              aria-label={`Sub-tasks of ${card.title}`}
              aria-expanded={childrenOpen}
              onClick={event => {
                event.stopPropagation(); toggleChildren?.()
              }}
            ><Icon name="chevron_right" size={14} />
            </Button>
          )}
          {!editing && (
            <CardTitle
              title={card.title}
              expanded={selected}
              open={() => void open({ id: card.id })}
              aria-controls={selected ? panelId({
                prefix: tabsId,
                id: 'context',
              }) : undefined}
              data-card={card.id}
              data-key-scope="hydra"
              tabIndex={tabIndex}
            />
          )}
          <HoverActions anchor={element}>
            <Tooltip content={windowed ? 'Open in place' : 'Open as a window'}>
              <Button
                aria-label={windowed ? 'Open in place' : 'Open as a window'}
                onClick={async () => {
                  if (!selected && !await open({ id: card.id })) {
                    return
                  }

                  setWindowed(value => !value)
                }}
              ><Icon name="open" size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Pause task">
              <Button
                aria-label="Pause task"
                disabled={!connected}
                onClick={() => command({
                  name: 'task',
                  args: [
                    'hold',
                    card.id,
                    '--message',
                    'Paused by owner',
                    '--event-id',
                    crypto.randomUUID(),
                  ],
                }).catch((error: Error) => notify({ text: error.message }))}
              ><Icon name="pause" size={15} />
              </Button>
            </Tooltip>
            {canStop && (
              <Button
                aria-label="Stop worker"
                title="Stop worker"
                onClick={async () => {
                  try {
                    await command({
                      name: 'task',
                      args: [
                        'stop',
                        card.id,
                      ],
                    })
                  } catch (error) {
                    notify({ text: (error as Error).message })
                  }
                }}
              >
                <Icon name="stop" size={12} />
              </Button>
            )}
            {card.parentId && (
              <Tooltip content="Move out of its parent">
                <Button
                  aria-label="Move out of its parent"
                  disabled={!connected}
                  onClick={() => command({
                    name: 'task',
                    args: [
                      'parent',
                      card.id,
                      'none',
                      '--event-id',
                      crypto.randomUUID(),
                    ],
                  }).catch((error: Error) => notify({ text: error.message }))}
                ><Icon name="chevron_right" size={15} />
                </Button>
              </Tooltip>
            )}
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
          <div className="card-open-content">
            <div className="card-details">
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
                {card.brief?.trim() && <section className="card-section" aria-label="Instructions"><h3 className="eyebrow">Instructions</h3><CollapsibleText text={card.brief} /></section>}
                <TaskQuestion
                  card={card}
                  connected={connected}
                  command={command}
                  notify={notify}
                  answer={answer}
                />
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
            </div>
            {chat}
          </div>
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
      {selected && (
        <Resize
          label="Resize card"
          axis="y"
          value={height}
          min={OPEN_CARD_MIN_HEIGHT}
          tabIndex={selected ? 0 : tabIndex}
          onPreview={({ value }) => setPreview(value)}
          onCommit={async ({ value }) => {
            try {
              return await save({
                patch: { cardHeights: { [card.id]: value } },
              })
            } finally {
              setPreview(null)
            }
          }}
        />
      )}
      {selected && (
        <Resize
          label="Resize card width"
          value={width}
          min={OPEN_CARD_MIN_WIDTH}
          onPreview={({ value }) => setWidthPreview(value)}
          onCommit={async ({ value }) => {
            try {
              return await save({
                patch: { workspace: { cardWidths: { [card.id]: value } } },
              })
            } finally {
              setWidthPreview(null)
            }
          }}
        />
      )}
    </article>
  )
})
