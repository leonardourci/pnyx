import { useRememberedScroll } from '#web-app/remembered-scroll.ts'
import { forgetSessionView, useSessionView } from '#web-app/session-view.ts'
import { taskViewKey } from './task-view.ts'
import { useStableActions } from '#web-shared/stable.ts'
import { ProfileSurface } from '#web-app/profile-surface.tsx'
import { AnimatePresence } from 'motion/react'
import { TaskCardModal } from './task-modal.tsx'
import { useTaskChatOnly, useTaskModal } from './presentation.ts'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { TaskCardDrag, TaskDragHandle } from './card-drag.tsx'
import { CardSummary, TaskLabels, cardTint } from './card-summary.tsx'
import { AgentDetails } from '#web-workers/agent-details.tsx'
import { memo, useCallback, useMemo, useEffect, useLayoutEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ReminderEditor, ReminderLabel, type ReminderDraft } from './reminder.tsx'
import type { Card as CardData, SavedLabelColor } from '#tasks/model.ts'
import type { LatestMessage } from '#hydra/transcripts-read.ts'
import { RichText } from '#web-shared/ui/rich-text.tsx'
import { CardTitle } from './card-title.tsx'
import { CardShell, CardContent, CardHeading, CardPanel, CardSection } from './card-shell.tsx'
import { TaskEditor, type TaskDraft } from './task-editor.tsx'
import type { ObservedStatus } from './observed-status.ts'
import { clickTogglesCard } from './card-click.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import type { Command } from '#web-app/connection.ts'
import { cardState } from './view.ts'
import { currentState, waitingQuestions } from '#tasks/card-status.ts'
import { Tabs, panelId, tabId } from '#web-shared/ui/tabs.tsx'
import { TaskQuestion } from './task-question.tsx'
import { harnessName } from '#web-workers/view.ts'

import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { Icon } from '#web-shared/icons.tsx'
import { relativeTime } from './brief.ts'
import { CardLinks } from './card-links.tsx'
import { CardState } from './card-state.tsx'
import { HoverActions } from '#web-shared/ui/hover-actions.tsx'
import type { CurrentAction } from '#hydra/calls.ts'
import type { DoneAfterHours } from '#settings/model.ts'

const STATE_SOURCE = {
  reminder: 'Scheduled reminder',
  review: 'Pull request update',
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

const CHAT_ONLY_LAYOUT = 'grid-cols-1 grid-rows-1 [&>.task-chat]:border-l-0'
const DETAILS_AND_CHAT_LAYOUT = 'grid-cols-1 grid-rows-2 @task-details/task:grid-cols-2 @task-details/task:grid-rows-1'

export const HydraCard = memo(function HydraCard({
  card,
  statusOverride,
  sortScope,
  rootColumn,
  rootScope,
  hydraId,
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
  openInline = selected,
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
  rootColumn?: string
  rootScope?: string
  hydraId: string
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
  // A modal opened from a closed card leaves that card closed on the board.
  openInline?: boolean
  open({
    id,
    pointer,
    focusPanel,
    modal,
  }: {
    id: string
    pointer?: boolean
    focusPanel?: boolean
    modal?: boolean
  }): Promise<boolean>
  onEdit(): void
  recoverSelection({ id }: { id: string }): void
  tabIndex: number
  command: Command
  connected: boolean
  children?: ReactNode
  answer({ card }: { card: CardData }): void
}) {
  const inlineElement = useRef<HTMLElement>(null)
  const modalElement = useRef<HTMLElement>(null)
  const [
    editing,
    setEditing,
  ] = useSessionView<{
    version: number
    draft?: TaskDraft
  } | null>({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'editing',
    }),
    initial: null,
  })
  const [
    ,, editVersion,
  ] = useSessionView({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'editVersion',
    }),
    initial: 0,
  })
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
    forgetSessionView({
      key: taskViewKey({
        hydraId,
        id: card.id,
        field: 'editor.title',
      }),
    })
    forgetSessionView({
      key: taskViewKey({
        hydraId,
        id: card.id,
        field: 'editor.brief',
      }),
    })
    const version = editVersion.snapshot() + 1
    editVersion.set(version)
    setEditing({
      version,
      draft,
    })

    if (!isSelected.current) {
      void open({
        id: card.id,
        focusPanel: false,
      })
    }
  }

  const {
    modal,
    showModal,
    closeModal,
  } = useTaskModal({
    id: card.id,
    hydraId,
  })
  const inlineHeight = selected && !modal ? 'h-column' : ''
  const element = modal ? modalElement : inlineElement
  const {
    chatOnly,
    toggleChatOnly,
  } = useTaskChatOnly()
  const wasModal = useRef(modal)
  useLayoutEffect(
    () => {
      if (wasModal.current && !modal) {
        element.current?.querySelector<HTMLElement>('.card-open')?.focus({ preventScroll: true })
      }

      wasModal.current = modal
    },
    [modal],
  )
  const tabsId = useId()
  const [
    tab,
    setTab,
  ] = useSessionView<'context' | 'activity'>({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'tab',
    }),
    initial: 'context',
  })
  useEffect(
    () => {
      if (!selected) {
        setTab('context')
      }
    },
    [selected],
  )
  const contextScroll = useRememberedScroll({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'contextScroll',
    }),
    active: selected && tab === 'context',
  })
  const activityScroll = useRememberedScroll({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'activityScroll',
    }),
    active: selected && tab === 'activity',
  })
  const openLayout = chatOnly ? CHAT_ONLY_LAYOUT : DETAILS_AND_CHAT_LAYOUT
  const [
    reminding,
    setReminding,
  ] = useSessionView<{
    version: number
    draft?: ReminderDraft
  } | null>({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'reminding',
    }),
    initial: null,
  })
  const [
    ,, reminderVersion,
  ] = useSessionView({
    key: taskViewKey({
      hydraId,
      id: card.id,
      field: 'reminderVersion',
    }),
    initial: 0,
  })
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
    />
  )
  const summaryActions = useStableActions({
    actions: {
      open: ({ pointer }: { pointer: boolean }) => modal ? closeModal() : void open({
        id: card.id,
        pointer,
      }),
    },
  })
  const closedSummary = useMemo(
    () => (
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
        open={summaryActions.open}
        agentDetails={card.agent ? <AgentDetails card={card} command={command} /> : undefined}
        editing={!!editing}
        tabIndex={tabIndex}
      />
    ),
    [
      card,
      status,
      now,
      labelColors,
      legacyProject,
      progress,
      hasChildren,
      childrenOpen,
      toggleChildren,
      summaryActions,
      command,
      editing,
      tabIndex,
    ],
  )
  const attachInline = useCallback(
    // eslint-disable-next-line pnyx/object-params -- React supplies the ref node.
    (node: HTMLElement | null) => {
      inlineElement.current = node
    },
    [],
  )
  const attachModal = useCallback(
    // eslint-disable-next-line pnyx/object-params -- React supplies the ref node.
    (node: HTMLElement | null) => {
      modalElement.current = node
    },
    [],
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
  })
  // Activity mounts only while it shows, so a hidden one reads no history; Context stays mounted to keep draft answers.
  const showsActivity = tab === 'activity'

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

  const menuActions = useStableActions({
    actions: {
      modal: async () => {
        if (!selected && !await open({
          id: card.id,
          modal: true,
        })) {
          return
        }

        if (modal) {
          closeModal()
        } else {
          showModal()
        }
      },
      pause: () => command({
        name: 'task',
        args: [
          'hold',
          card.id,
          '--reason',
          'Paused by owner',
          '--event-id',
          crypto.randomUUID(),
        ],
      }).catch((error: Error) => notify({ text: error.message })),
      stop: async () => {
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
      },
      removeParent: () => command({
        name: 'task',
        args: [
          'parent',
          card.id,
          'none',
          '--event-id',
          crypto.randomUUID(),
        ],
      }).catch((error: Error) => notify({ text: error.message })),
      edit: () => edit(),
      remind: () => {
        forgetSessionView({
          key: taskViewKey({
            hydraId,
            id: card.id,
            field: 'reminder.when',
          }),
        })
        const version = reminderVersion.snapshot() + 1
        reminderVersion.set(version)
        setReminding({ version })
      },
      hide: async () => {
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
      },
    },
  })
  const hoverActions = useMemo(
    () => (
      <HoverActions anchor={element}>
        <TaskDragHandle
          label={`Move ${card.title}`}
          disabled={modal || !connected}
          icon="grip"
          size="compact"
        />
        <Tooltip content={modal ? 'Close modal' : 'Open modal'}>
          <IconButton
            label={modal ? 'Close modal' : 'Open modal'}
            onClick={menuActions.modal}
            icon={modal ? 'close' : 'open'}
            size="compact"
          />
        </Tooltip>
        <Tooltip content="Pause task">
          <IconButton
            label="Pause task"
            disabled={!connected}
            onClick={menuActions.pause}
            icon="pause"
            size="compact"
          />
        </Tooltip>
        {canStop && (
          <IconButton
            label="Stop worker"
            title="Stop worker"
            onClick={menuActions.stop}
            icon="stop_outline"
            size="compact"
          />
        )}
        {card.parentId && (
          <Tooltip content="Remove from parent">
            <IconButton
              label="Remove from parent"
              disabled={!connected}
              onClick={menuActions.removeParent}
              icon="outdent"
              size="compact"
            />
          </Tooltip>
        )}
        <Tooltip content="Edit task">
          <IconButton
            label="Edit task"
            disabled={!connected || !!editing}
            onClick={menuActions.edit}
            icon="edit"
            size="compact"
          />
        </Tooltip>
        <Tooltip content="Remind">
          <IconButton
            label="Remind"
            disabled={!connected}
            onClick={menuActions.remind}
            icon="remind"
            size="compact"
          />
        </Tooltip>
        <Tooltip content="Hide">
          <IconButton
            label="Hide"
            disabled={!connected}
            onClick={menuActions.hide}
            icon="hide"
            size="compact"
          />
        </Tooltip>
      </HoverActions>
    ),
    [
      element,
      card.title,
      card.parentId,
      modal,
      connected,
      canStop,
      editing,
      menuActions,
    ],
  )

  const shell = (
    <TaskCardDrag
      item={{
        id: card.id,
        kind: 'task',
        scope: sortScope ?? '',
        hydra: hydraId,
        parent: card.parentId,
        root: rootColumn && rootScope ? {
          column: rootColumn,
          scope: rootScope,
        } : undefined,
        hasChildren,
        open: selected,
        overlay: (
          <div><CardShell lifted tint={tint}><CardContent>{summary}</CardContent></CardShell></div>
        ),
      }}
      disabled={{
        draggable: modal || !connected || !!reminding || !!editing,
        droppable: !connected,
      }}
      modal={modal}
      layout={false}
      className={`@container/task ${inlineHeight} ${modal ? 'min-h-0! flex-1! rounded-none! border-0! bg-transparent!' : ''}`}
      elementRef={modal ? attachModal : attachInline}
      selected={selected}
      data-task={card.id}
      data-task-hydra={hydraId}
      data-tab={selected ? tab : undefined}
      tint={tint}
      onClick={modal ? undefined : click}
      data-sort-id={card.id}
      data-sort-kind="task"
      data-sort-scope={sortScope}
      data-sort-disabled={modal || !connected || !!reminding || !!editing}
      data-parent={card.parentId}
      data-has-children={hasChildren}

    >
      <CardContent>
        <header
          data-card-header
          className={selected ? `flex shrink-0 flex-col gap-1.5 ${modal ? '' : 'cursor-grab touch-none [&_.card-open]:cursor-grab'}` : 'contents'}
        >
          {!selected && closedSummary}
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
              {!modal && (
                <CardHeading
                  title={card.title}
                >
                  {!editing && (
                    <CardTitle
                      title={card.title}
                      expanded={selected}
                      open={({ pointer }) => modal ? closeModal() : void open({
                        id: card.id,
                        pointer,
                      })}
                      aria-controls={selected ? panelId({
                        prefix: tabsId,
                        id: 'context',
                      }) : undefined}
                      data-card={card.id}
                      data-key-scope="hydra"
                      tabIndex={tabIndex}
                    />
                  )}

                </CardHeading>
              )}
            </>
          )}
          {editing && (
            <TaskEditor
              hydraId={hydraId}
              key={editing.version}
              version={editing.version}
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
                if (editVersion.snapshot() === editing.version) {
                  edit({ draft })
                }

                notify({ text: error.message })
              }}
            />
          )}
          {selected && (
            <div className="flex min-w-0 items-center justify-between gap-2">
              {!chatOnly && (
                <Tabs
                  divider={false}
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
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {hasChildren && toggleChildren && (
                  <IconButton
                    icon={childrenOpen ? 'fold_tasks' : 'unfold_tasks'}
                    label={`Sub-tasks of ${card.title}`}
                    title={childrenOpen ? 'Fold sub-tasks' : 'Unfold sub-tasks'}
                    aria-expanded={childrenOpen}
                    onClick={toggleChildren}
                  />
                )}
                <IconButton
                  icon={chatOnly ? 'summary_show' : 'summary_hide'}
                  label={chatOnly ? 'Show task summary' : 'Focus on chat'}
                  aria-pressed={chatOnly}
                  onClick={toggleChatOnly}
                />
              </div>
            </div>
          )}
        </header>
        {selected && (
          <div className={`card-open-content grid min-h-0 flex-1 gap-3.5 pt-1.5 ${openLayout}`}>
            <div hidden={chatOnly} className="card-details flex min-h-0 min-w-0 flex-col gap-2 overflow-auto [&[hidden]]:hidden">
              <CardPanel ref={contextScroll.ref} {...panel({ id: 'context' })}>
                {card.notices?.map(notice => (
                  <div
                    key={JSON.stringify([
                      notice.task,
                      notice.reason,
                      notice.clear,
                    ])}
                    className="text-meta text-gold"
                  >
                    <RichText text={`${notice.reason}. ${notice.clear}`} />
                  </div>
                ))}
                {card.copy?.state === 'flagged' && <div className="copy-warning text-meta text-gold"><RichText text={card.copy.reason ?? ''} /></div>}
                {waiting.length > 0 && (card.intent || factual) && (
                  <ContextIndex
                    questions={waiting.length}
                    intent={!!card.intent}
                    state={!!factual}
                  />
                )}
                {card.brief?.trim() && <CardSection heading="Instructions"><RichText text={card.brief} /></CardSection>}
                <TaskQuestion
                  card={card}
                  connected={connected}
                  command={command}
                  notify={notify}
                  answer={answer}
                />
                {card.intent && (
                  <CardSection heading="Intent" className="card-intent">
                    <RichText text={card.intent} />
                  </CardSection>
                )}
                {factual && (
                  <CardSection heading="Latest update" className="card-current-state">
                    <RichText text={factual.text} />
                    <p className="muted small">{stateSource}, {relativeTime({
                      at: factual.at,
                      now,
                    })}
                    </p>
                  </CardSection>
                )}
                {labels}
                <CardLinks links={card.links} expanded />
                <ReminderLabel card={card} />
              </CardPanel>
              <CardPanel ref={activityScroll.ref} {...panel({ id: 'activity' })}>
                {showsActivity && (
                  <>
                    {!!card.ask?.length && (
                      <CardSection heading="Your words">
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
                      </CardSection>
                    )}
                    {card.launch?.dispatch && <div className="muted small"><RichText text={card.launch.dispatch} /></div>}
                    {children}
                  </>
                )}
              </CardPanel>
            </div>
            {chat}
          </div>
        )}
        {reminding && (
          <ReminderEditor
            hydraId={hydraId}
            card={card}
            version={reminding.version}
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
              if (reminderVersion.snapshot() === reminding.version) {
                setReminding({
                  ...reminding,
                  draft,
                })
              }

              notify({ text: draft.error })
            }}
          />
        )}
      </CardContent>
      {hoverActions}
    </TaskCardDrag>
  )

  return (
    <ProfileSurface name="task" hydraId={hydraId}>
      {modal && selected && (
        <CardShell
          aria-hidden
          inert
          className={openInline ? 'invisible h-column' : 'invisible'}
        >{openInline ? summary : <CardContent>{closedSummary}</CardContent>}
        </CardShell>
      )}
      <AnimatePresence initial={false} onExitComplete={() => element.current?.querySelector<HTMLElement>('.card-open')?.focus({ preventScroll: true })}>
        {modal && selected ? (
          <TaskCardModal
            key="modal"
            layoutId={`task:${hydraId}:${card.id}`}
            title={card.title}
            close={closeModal}
          >
            {shell}
          </TaskCardModal>
        ) : shell}
      </AnimatePresence>
    </ProfileSurface>
  )
})
