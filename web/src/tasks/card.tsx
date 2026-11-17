import { motion } from 'motion/react'
import { DragNestHint, useSortItem, useSortState, useDropZone } from '#web-shared/ui/sortable.tsx'
import { CardSummary, TaskLabels, CARD_SURFACE, CARD_CONTENT, cardTint } from './card-summary.tsx'
import { AgentDetails } from '#web-workers/agent-details.tsx'
import { memo, useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useKeyAction } from '#web-preferences/keyboard-registry.tsx'
import { ReminderEditor, ReminderLabel, type ReminderDraft } from './reminder.tsx'
import type { ViewPreferences } from '#preferences/model.ts'
import type { Card as CardData, SavedLabelColor } from '#tasks/model.ts'
import type { LatestMessage } from '#hydra/transcripts-read.ts'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { CardTitle } from './card-title.tsx'
import { TaskEditor, type TaskDraft } from './task-editor.tsx'
import { OPEN_CARD_MIN_HEIGHT, DEFAULT_OPEN_CARD_HEIGHT } from '#preferences/workspace.ts'
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
import { HoverActions, CARD_LAYOUT_COMPLETE } from '#web-shared/ui/hover-actions.tsx'
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
    <nav className="card-index flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted [&_.button]:min-h-0 [&_.button]:px-1 [&_.button]:py-0 [&_.button]:text-meta" aria-label="On this card">
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
  hydraId,
  dragChildren,
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
  hydraId: string
  dragChildren?: ReactNode
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
  const tint = cardTint({
    card,
    colors: labelColors,
  })
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

  const labels = (
    <TaskLabels
      card={card}
      showProject={false}
      legacyProject={legacyProject}
      colors={labelColors}
    />
  )
  const summary = (
    <CardSummary
      card={card}
      status={status}
      now={now}
      colors={labelColors}
      legacyProject={legacyProject}
      progress={progress}
      hasChildren={hasChildren}
      childrenOpen={childrenOpen}
      trailingLabel={!hasChildren && <DragNestHint />}
    />
  )
  const sort = useSortItem({
    item: {
      id: card.id,
      kind: 'task',
      scope: sortScope ?? '',
      hydra: hydraId,
      parent: card.parentId,
      hasChildren,
      overlay: <div><div className={`${CARD_SURFACE} border-gold-line`} data-label-color={tint}><div className={CARD_CONTENT}>{summary}</div></div>{dragChildren}</div>,
    },
    disabled: {
      draggable: selected || !connected || !!reminding || !!editing,
      droppable: !connected,
    },
  })
  const hoverZone = useDropZone({
    item: {
      id: card.id,
      kind: 'task',
      scope: sortScope ?? '',
      hydra: hydraId,
      zone: 'nest',
    },
    disabled: !!card.parentId || !connected,
  })
  const sortableNode = sort.setNodeRef
  const attach = useCallback(
    // eslint-disable-next-line pnyx/object-params -- React supplies the ref node.
    (node: HTMLElement | null) => {
      element.current = node
      hoverZone.setNodeRef(node)
      const wrapper = card.parentId ? '[data-child]' : '[data-family]'
      sortableNode(node?.closest<HTMLElement>(wrapper) ?? node)
    },
    [
      sortableNode,
      hoverZone.setNodeRef,
      card.parentId,
    ],
  )
  const drag = useSortState()
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
    className: 'card-panel flex min-h-0 min-w-0 flex-1 flex-col gap-2.25 overflow-auto [&[hidden]]:hidden [&>.detail]:flex-none [&>.detail]:overflow-visible',
  })
  // Activity mounts only while it shows, so a hidden one reads no history or report; Context stays mounted to keep draft answers.
  const showsActivity = tab === 'activity'

  // eslint-disable-next-line pnyx/object-params -- Motion supplies the React keyboard event.
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && windowed && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation(); setWindowed(false)
    }
  }

  const click = ({
    currentTarget,
    target,
  }: MouseEvent<HTMLElement>) => {
    if (clickTogglesCard({
      card: currentTarget,
      target: target instanceof Element ? target : null,
      selecting: !!window.getSelection()?.toString(),
    })) {
      open({
        id: card.id,
        pointer: true,
      })
    }
  }

  const layoutComplete = () => {
    element.current?.dispatchEvent(new Event(CARD_LAYOUT_COMPLETE))
  }

  return (
    <motion.article
      layout={preview === null}
      onLayoutAnimationComplete={layoutComplete}
      ref={attach}
      onPointerDown={sort.pointerDown}
      data-sort-key={sort.key}
      data-nest-armed={drag.shift && drag.over?.zone === 'nest' && drag.over.id === card.id}
      className={`${CARD_SURFACE} touch-pan-y data-[nest-armed=true]:border-gold-line data-[nest-armed=true]:ring-2 data-[nest-armed=true]:ring-inset data-[nest-armed=true]:ring-gold transition-colors duration-150 motion-reduce:transition-none has-[.resize:active]:transition-colors backdrop:bg-shadow ${selected ? 'selected border-gold-line' : 'border-line select-none hover:border-control has-[.card-open:focus-visible]:border-gold'} data-[windowed=true]:fixed data-[windowed=true]:top-card-window-top data-[windowed=true]:left-1/2 data-[windowed=true]:right-auto data-[windowed=true]:bottom-auto data-[windowed=true]:-translate-x-1/2 data-[windowed=true]:bg-surface data-[windowed=true]:text-ink data-[windowed=true]:shadow-window`}
      style={{
        height: selected ? (preview ?? height) : undefined,
        width: selected && windowed ? 'var(--project-card-width)' : undefined,
      }}
      data-task={card.id}
      data-windowed={windowed}
      onKeyDown={keyDown}
      data-tab={selected ? tab : undefined}
      data-label-color={tint}
      onClick={click}
      data-sort-id={card.id}
      data-sort-kind="task"
      data-sort-scope={sortScope}
      data-sort-disabled={selected || !connected || !!reminding || !!editing}
      data-parent={card.parentId}
      data-has-children={hasChildren}

    >
      <motion.div layout="position" className={CARD_CONTENT}>
        {!selected && (
          <CardSummary
            card={card}
            status={status}
            now={now}
            colors={labelColors}
            legacyProject={legacyProject}
            progress={progress}
            hasChildren={hasChildren}
            childrenOpen={childrenOpen}
            toggleChildren={toggleChildren}
            open={() => void open({ id: card.id })}
            agentDetails={card.agent ? <AgentDetails card={card} command={command} /> : undefined}
            editing={!!editing}
            tabIndex={tabIndex}
          />
        )}
        {selected && (
          <>
            <CardState
              card={card}
              status={status}
              now={now}
              labelColors={labelColors}
              tooltips
              compact={!selected}
              progress={progress}
              showProject={selected && showProject}
              legacyProject={legacyProject}
            >
              {card.agent && (
                <Tooltip
                  content={<AgentDetails card={card} command={command} />}
                  interactive
                  label="Agent details"
                >
                  <span className="card-agent ml-auto inline-flex text-muted" tabIndex={0} aria-label={harnessName({ provider: card.agent.provider })}>
                    <Icon name={card.agent.provider} />
                  </span>
                </Tooltip>
              )}
            </CardState>
            <div className="card-title-row flex min-w-0 items-start gap-1.25 [&>.tooltip-anchor]:shrink-0">
              {hasChildren && (
                <Button
                  className="subtask-toggle min-w-3.5 flex-none px-0 py-0.5 aria-expanded:[&_svg]:rotate-90"
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

            </div>
          </>
        )}
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
          <div className="card-open-content grid min-h-0 flex-1 grid-cols-[minmax(var(--spacing-card-details),1fr)_minmax(var(--spacing-card-chat),1fr)] gap-3.5 pt-1.5">
            <div className="card-details flex min-h-0 min-w-0 flex-col gap-2 overflow-auto">
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
                {card.copy?.state === 'flagged' && <div className="copy-warning"><RichText text={card.copy.reason ?? ''} /></div>}
                {waiting.length > 0 && (card.intent || factual) && (
                  <ContextIndex
                    questions={waiting.length}
                    intent={!!card.intent}
                    state={!!factual}
                  />
                )}
                {card.brief?.trim() && <section className="card-section flex flex-col gap-0.75 [&>.eyebrow]:m-0 [&>.eyebrow]:text-gold!" aria-label="Instructions"><h3 className="eyebrow">Instructions</h3><RichText text={card.brief} /></section>}
                <TaskQuestion
                  card={card}
                  connected={connected}
                  command={command}
                  notify={notify}
                  answer={answer}
                />
                {card.intent && (
                  <section className="card-section card-intent flex flex-col gap-0.75 [&>.eyebrow]:m-0 [&>.eyebrow]:text-gold!" aria-label="Intent">
                    <h3 className="eyebrow">Intent</h3>
                    <RichText text={card.intent} />
                  </section>
                )}
                {factual && (
                  <section className="card-section card-current-state flex flex-col gap-0.75 [&>.eyebrow]:m-0 [&>.eyebrow]:text-gold!" aria-label="Current state">
                    <h3 className="eyebrow">Current state</h3>
                    <RichText text={factual.text} />
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
                      <section className="card-section flex flex-col gap-0.75 [&>.eyebrow]:m-0 [&>.eyebrow]:text-gold!" aria-label="Your words">
                        <h3 className="eyebrow">Your words</h3>
                        {card.ask.map(entry => (
                          <div key={`${entry.at}-${entry.message ?? ''}`} className="card-owner-words [&+&]:mt-1.5">
                            <RichText text={entry.text} />
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
                    {card.launch?.dispatch && <div className="muted small"><RichText text={card.launch.dispatch} /></div>}
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
      </motion.div>
      <HoverActions anchor={element}>
        <Button
          {...sort.attributes}
          {...sort.listeners}
          ref={sort.setActivatorNodeRef}
          data-drag-handle
          aria-label={`Move ${card.title}`}
          disabled={selected || !connected}
        ><Icon name="grip" size={15} />
        </Button>
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
                '--reason',
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
      {selected && (
        <Resize
          className="bottom-0! right-auto! left-[calc(50%-3rem)]! h-6! w-24 after:top-4.25! after:bg-muted hover:after:bg-gold focus:after:bg-gold"
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
    </motion.article>
  )
})
