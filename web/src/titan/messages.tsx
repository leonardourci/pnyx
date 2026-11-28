import { MessageBubble, MessageFooter } from './message-surface.tsx'
import type { ChatDrafts } from './chat-drafts.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { upgradeMilestoneIcon } from '#upgrade/model.ts'
import { skillIcon } from './skill-icons.ts'
import type { TurnActions } from '#titan/conversation.ts'
import type { Catalog } from '#titan/transcripts-catalog.ts'
import type { ThreadEntry } from '#titan/transcripts-read.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { isEditing } from '#web-shared/ui/focus.ts'
import { kept } from '#web-shared/stable.ts'
import { Button,InlineButton } from '#web-shared/ui/controls.tsx'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { SavedTaskLabels,TaskReference,TaskReferencesProvider,type TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { columnLook } from '#web-tasks/view.ts'
import {
  memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,
  type ComponentProps,type RefObject,type ReactNode,
  type KeyboardEvent as KeyEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChatTokensContext } from './chat-token-text.tsx'
import { clock,copiedText,orderedComments,type ChatComment } from './chat.ts'
import { leadingTask, ownMessage, type TurnTiming } from '#titan/chat-messages.ts'
import { copyMessageChips } from './clipboard.ts'
import { CommentAnnotations } from './comment-annotations.tsx'
import { useCommentDrafts } from './comment-drafts.ts'
import { focusChatComposer } from './composer-shortcut.ts'
import { HIGHLIGHT_SUPPORTED,clearHighlights,commentHighlightName,paintComments } from './comment-highlight.ts'
import { revealComment } from './comment-reveal.ts'
import { MessageComment } from './message-comment.tsx'
import {
  MESSAGE_CONTROLS,MESSAGE_DECORATIONS,isMessageBlockKey,messageBlock,messageBlockKey,samePassage,
  selectedPassage,type CommentPassage,
} from './message-selection.ts'
import type { OthrysLookup } from './othrys-action.ts'
import { MessageText } from './streaming.tsx'
import { AnswerLeadHead, openFoldedQuestion } from './answer-lead.tsx'
import type { AnswerLead } from './answer-leads.ts'
import { roleLabel } from './trace-row.tsx'
import { TurnActionsFold,TurnFooter } from './turn-actions.tsx'

const SELECTION_ACTIONS_SELECTOR = '.comment-pill, .comment-dock'
let highlights = 0

function selectionBelongsToMessages({
  selection,
  messages,
}: {
  selection: Selection | null
  messages: HTMLElement | null
}) {
  return Boolean(selection && messages?.contains(selection.anchorNode)
    && messages.contains(selection.focusNode))
}

// A message the owner just sent shows at once, faded until the server records it.
export type ChatEntry = ThreadEntry & {
  sending?: boolean
  checking?: boolean
  // Why the owner's message was not sent; it stays with a retry.
  unsent?: string
  renderKey?: string
}

function useKeptEntries({ entries }: { entries: ChatEntry[] }) {
  const held = useRef<ChatEntry[]>([])
  const previous = new Map(held.current.map(entry => [
    entry.renderKey ?? entry.id,
    entry,
  ]))
  const next = entries.map(entry => kept({
    previous: previous.get(entry.renderKey ?? entry.id) ?? entry,
    next: entry,
  }))
  const unchanged = next.length === held.current.length && next.every((
    entry,
    index,
  ) => entry === held.current[index])

  if (!unchanged) {
    held.current = next
  }

  return held.current
}

function MessageTask({ entry }: { entry: ChatEntry }) {
  const task = leadingTask({ entry })

  return task ? (
    <span className="message-lead relative z-1 float-left max-w-full mr-message-reference text-chat leading-(--chat-line) font-chat [&_.task-reference-space]:hidden [&_.draft-chip]:m-0 [&:is(:has(+.markdown>:first-child:not(.message-block)),:has(+.markdown>.message-block:first-child>:first-child:not(p)))]:float-none [&:is(:has(+.markdown>:first-child:not(.message-block)),:has(+.markdown>.message-block:first-child>:first-child:not(p)))]:block [&:is(:has(+.markdown>:first-child:not(.message-block)),:has(+.markdown>.message-block:first-child>:first-child:not(p)))]:mb-(--block-gap)">
      <TaskReference id={task} />
    </span>
  ) : null
}

function MessageLead({
  entry,
  lead,
}: {
  entry: ChatEntry
  lead?: AnswerLead
}) {
  return lead ? <AnswerLeadHead lead={lead} /> : <MessageTask entry={entry} />
}

function ChatMessageText({
  catalog,
  colors,
  savedTaskLabels = false,
  ...props
}: ComponentProps<typeof MessageText> & {
  catalog?: Catalog | null
  colors?: SavedLabelColor[]
  savedTaskLabels?: boolean
}) {
  return (
    <ChatTokensContext.Provider
      value={{
        suggestions: catalog?.suggestions,
        colors,
      }}
    >
      <SavedTaskLabels.Provider value={savedTaskLabels}>
        <MessageText {...props} />
      </SavedTaskLabels.Provider>
    </ChatTokensContext.Provider>
  )
}

// The icon beside a milestone line: the inscribe skill's, or the one of the upgrade's state.
function MilestoneIcon({ text }: { text: string }) {
  const inscribe = skillIcon({
    skill: {
      name: INSCRIBE_SKILL,
      builtin: true,
    },
  })
  const name = text === 'Inscribed' ? inscribe : upgradeMilestoneIcon({ text })

  return name ? <Icon name={name} size={ICON_SIZE.inline} /> : null
}

interface RowComment {
  comment: ChatComment
  number: number
}
interface MessageActions {
  remove({ id }: { id: string }): void
  release({ id }: { id: string }): void
  retry?({
    id,
    text,
    reference,
    replyId,
    targetAgent,
  }: ChatEntry): void

}
const NO_COMMENTS: RowComment[] = []

const MessageRow = memo(function MessageRow({
  entry,
  fold,
  trailing,
  timing,
  inline,
  hasInline,
  lead,
  hasTaskReferences,
  catalog,
  labelColors,
  assistantLabel,
  lookup,
  toolDetails,
  thinkingDetails,
  comments,
  active,
  drafts,
  root,
  actions,
  lookColumn,
  leadingTitle,
  timingTitle,
  openTask,
  canRetry,
}: {
  entry: ChatEntry
  fold?: TurnActions
  trailing?: ThreadEntry[]
  timing?: TurnTiming
  inline?: ReactNode
  hasInline: boolean
  lead?: AnswerLead
  hasTaskReferences: boolean
  catalog?: Catalog | null
  labelColors?: SavedLabelColor[]
  assistantLabel?: string
  lookup: OthrysLookup
  toolDetails: boolean
  thinkingDetails: boolean
  comments: RowComment[]
  active: string | null
  drafts: ChatDrafts
  root: RefObject<HTMLDivElement | null>
  actions: RefObject<MessageActions>
  lookColumn({ id }: { id: string }): ReturnType<typeof columnLook>
  leadingTitle?: string
  timingTitle?: string
  openTask?({ id }: { id: string }): void
  canRetry: boolean
}) {
  const retryMessage = canRetry && entry.unsent !== undefined
  const sentAt = entry.sent ?? entry.at

  return entry.kind === 'divider' ? (
    <div
      className="chat-divider flex items-center gap-2.5 my-2.5 mx-0 text-muted text-meta before:content-[''] before:flex-1 before:border-t before:border-line after:content-[''] after:flex-1 after:border-t after:border-line"
      role="separator"
      aria-label={entry.text}
    >
      <MilestoneIcon text={entry.text} />
      <span>{entry.text}</span>
    </div>
  ) : (
    <>
      {fold?.notes.length ? (
        <TurnActionsFold
          fold={{
            tasks: [],
            notes: fold.notes,
          }}
          lookup={lookup}
          toolDetails={toolDetails}
          thinkingDetails={thinkingDetails}
        />
      ) : null}
      <MessageBubble
        data-entry-id={entry.id}
        kind={entry.kind}
        mine={ownMessage({ entry })}
        aria-label={roleLabel({
          role: entry.role,
          assistantLabel,
        })}
        data-streaming={entry.streaming || undefined}
        data-sending={entry.sending || undefined}
        data-unsent={entry.unsent !== undefined || undefined}
        data-othrys={entry.role === 'Othrys' || undefined}
        title={entry.at && !ownMessage({ entry })
          ? new Date(entry.at).toLocaleString() : undefined}
        onClick={lead ? ({
          target,
          currentTarget,
        }) => openFoldedQuestion({
          target,
          bubble: currentTarget,
        }) : undefined}
      >
        {hasTaskReferences && !hasInline && (
          <MessageLead entry={entry} lead={lead} />
        )}
        {inline ?? (
          <ChatMessageText
            catalog={ownMessage({ entry }) ? catalog : undefined}
            colors={labelColors}
            savedTaskLabels={entry.role === 'Othrys'}
            text={entry.text}
            streaming={entry.streaming}
            decorations={MESSAGE_DECORATIONS}
            openTask={openTask}
            columnLook={lookColumn}
            block={({
              index,
              offset: local,
              quote,
              children,
            }) => {
              const messageId = entry.messageId ?? entry.id
              const offset = (entry.part ?? 0) + local
              const key = messageBlockKey({
                messageId,
                offset,
              })
              const own = comments.filter(item => item.comment.offset === offset)

              return (
                <div
                  className="message-block relative min-w-0 rounded-preview"
                  data-message-block={key}
                  data-message-id={messageId}
                  data-message-at={entry.at}
                  data-message-reference={entry.reference}
                  data-block-index={index}
                  data-block-offset={offset}
                  data-quote={quote}
                  data-active={active === key}
                  role="group"
                  aria-label={`Message block ${index + 1}`}
                >
                  {children}
                  {own.map(({
                    comment,
                    number,
                  }) => (
                    <MessageComment
                      key={comment.id}
                      comment={comment}
                      drafts={drafts}
                      number={number}
                      inline
                      remove={() => actions.current.remove({ id: comment.id })}
                      release={() => actions.current.release({ id: comment.id })}
                      show={() => {
                        if (root.current) {
                          revealComment({
                            host: root.current,
                            comment,
                          })
                        }
                      }}
                    />
                  ))}
                </div>
              )
            }}
          />
        )}
      </MessageBubble>
      {ownMessage({ entry }) && !entry.continued && (
        <MessageFooter variant="owner">
          {entry.checking && <span className="muted" role="status">Checking…</span>}
          {entry.unsent !== undefined && (
            <span className="unsent inline-flex items-center gap-1 px-1 py-0 text-red" role="alert">
              <Icon name="error" size={ICON_SIZE.inline} />Not sent · {entry.unsent}
            </span>
          )}
          {retryMessage && (
            <InlineButton onClick={() => actions.current.retry?.(entry)}>
              Retry
            </InlineButton>
          )}
          {sentAt && (
            <time
              dateTime={sentAt}
              title={`Sent ${new Date(sentAt).toLocaleDateString()}, ${clock({
                at: sentAt,
                seconds: true,
              })}`}
            >{clock({ at: sentAt })}
            </time>
          )}
          <CopyButton
            label="Copy message"
            text={() => copiedText({
              text: entry.text,
              task: leadingTask({ entry }),
              title: leadingTitle,
            })}
          />
        </MessageFooter>
      )}
      {trailing?.length ? (
        <TurnActionsFold
          fold={{
            tasks: [],
            notes: trailing,
          }}
          lookup={lookup}
          toolDetails={toolDetails}
          thinkingDetails={thinkingDetails}
        />
      ) : null}
      {fold?.tasks.length ? (
        <TurnActionsFold
          fold={{
            tasks: fold.tasks,
            notes: [],
          }}
          lookup={lookup}
        />
      ) : null}
      {timing !== undefined && (
        <TurnFooter turn={timing} taskTitle={timingTitle} />
      )}
    </>
  )
})

function SelectionActionButton({
  act,
  ...props
}: ComponentProps<typeof Button> & { act(): void }) {
  return (
    <Button
      {...props}
      onPointerDown={event => {
        if (event.button === 0) {
          event.preventDefault()
          act()
        }
      }}
      onClick={event => {
        if (event.detail === 0) {
          act()
        }
      }}
    />
  )
}

export function Messages({
  entries: givenEntries,
  lookup,
  comments,
  drafts,
  quote,
  toolDetails = true,
  thinkingDetails = true,
  taskReferences,
  openTask,
  assistantLabel,
  notify,
  folds,
  trailing,
  inline,
  timings,
  catalog,
  labelColors,
  retry,
  answerLeads,
}: {
  retry?({
    id,
    text,
    reference,
    replyId,
    targetAgent,
  }: ChatEntry): void
  // The question each answering owner message carries, by message id.
  answerLeads?: Map<string, AnswerLead>
  catalog?: Catalog | null
  labelColors?: SavedLabelColor[]
  timings: Map<string, TurnTiming>
  folds?: Map<string, TurnActions>
  // Progress shown after an entry: the rest of its turn so far, or a turn that ended without a reply.
  trailing?: Map<string, ThreadEntry[]>
  inline?: Map<string, React.ReactNode>
  notify({ text }: { text: string }): void
  openTask?({ id }: { id: string }): void
  taskReferences?: Record<string, TaskReferenceData>
  toolDetails?: boolean
  thinkingDetails?: boolean
  assistantLabel?: string
  entries: ChatEntry[]
  lookup: OthrysLookup
  comments: ChatComment[]
  drafts: ChatDrafts
  quote({ text }: { text: string }): void
}) {
  const entries = useKeptEntries({ entries: givenEntries })
  const root = useRef<HTMLDivElement>(null)
  const [
    active,
    setActive,
  ] = useState<string | null>(null)
  const [
    selection,
    setSelection,
  ] = useState<CommentPassage | null>(null)
  const [
    chatViewport,
    setChatViewport,
  ] = useState<Element | null>(null)
  useLayoutEffect(
    () => setChatViewport(root.current?.closest('.chat-viewport') ?? null),
    [],
  )
  const ordered = useMemo(
    () => orderedComments({ comments }),
    [comments],
  )
  const previousCommentRows = useRef(new Map<string, RowComment[]>())
  const rowComments = useMemo(
    () => {
      const grouped = new Map<string, RowComment[]>()
      ordered.forEach((
        comment,
        index,
      ) => {
        const items = grouped.get(comment.messageId) ?? []
        items.push({
          comment,
          number: index + 1,
        })
        grouped.set(
          comment.messageId,
          items,
        )
      })

      for (const [
        message,
        items,
      ] of grouped) {
        const before = previousCommentRows.current.get(message)

        if (before && before.length === items.length && items.every((
          item,
          index,
        ) =>
          item.comment === before[index]?.comment && item.number === before[index]?.number)) {
          grouped.set(
            message,
            before,
          )
        }
      }

      previousCommentRows.current = grouped

      return grouped
    },
    [ordered],
  )
  const lookColumn = columnLook
  const currentOpen = useRef(openTask)
  currentOpen.current = openTask
  const open = useCallback(
    ({ id }: { id: string }) => currentOpen.current?.({ id }),
    [],
  )

  const {
    addComment,
    pasteAsComment,
    remove,
    release,
  } = useCommentDrafts({
    root,
    drafts,
    notify,
    clearSelection: () => setSelection(null),
  })

  const removeAndKeepFocus = ({ id }: { id: string }) => {
    remove({ id })
    root.current?.focus({ preventScroll: true })
  }

  const handlers: MessageActions = {
    remove: removeAndKeepFocus,
    release,
    retry,
  }
  const actions = useRef(handlers)
  actions.current = handlers

  useEffect(() => {
    if (!selection) {
      return
    }

    const selectionShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const selected = window.getSelection()
      const action = target?.closest(SELECTION_ACTIONS_SELECTOR)
      const actionInThisChat = action && action.closest('.chat-viewport') === chatViewport
      const selectionInThisChat = selectionBelongsToMessages({
        selection: selected,
        messages: root.current,
      })

      if (event.key === 'Escape' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !event.defaultPrevented && !event.isComposing
        && target !== root.current && !actionInThisChat) {
        setSelection(null)

        if (selected && !selected.isCollapsed && selectionInThisChat) {
          selected.removeAllRanges()
        }

        return
      }

      if (event.defaultPrevented || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey ||
        event.key.length !== 1 || action ||
        (target && isEditing({ target })) ||
        !selected?.toString().trim() || !selectionInThisChat) {
        return
      }

      event.preventDefault(); event.stopPropagation()
      addComment({
        quote: selection,
        text: event.key,
      })
    }

    window.addEventListener(
      'keydown',
      selectionShortcut,
      true,
    )

    return () => window.removeEventListener(
      'keydown',
      selectionShortcut,
      true,
    )
  })

  useEffect(
    () => {
      let retainCollapsedSelection = false

      const trackSelection = ({ mouseButtons }: { mouseButtons: number }) => {
        if (mouseButtons) {
          return
        }

        const browserSelection = window.getSelection()
        const focusNode = browserSelection?.focusNode ?? null
        const block = root.current?.contains(focusNode) ? messageBlock({ node: focusNode }) : null
        const next = selectedPassage({ messages: root.current })
        const focusedAction = document.activeElement?.closest(SELECTION_ACTIONS_SELECTOR)
        const actionInThisChat = focusedAction
          && focusedAction.closest('.chat-viewport') === root.current?.closest('.chat-viewport')
        const selectionCollapsed = browserSelection?.isCollapsed ?? true
        const keepPassage = selectionCollapsed && (retainCollapsedSelection || actionInThisChat)

        const blockKey = block?.dataset.messageBlock

        if (blockKey && !document.activeElement?.closest('.comment-card')) {
          setActive(blockKey)
        }

        setSelection(prior => {
          if (!next) {
            return keepPassage ? prior : null
          }

          return samePassage({
            before: prior,
            after: next,
          }) ? prior : next
        })
      }

      const rememberPointerType = (event: PointerEvent) => {
        retainCollapsedSelection = event.pointerType === 'touch' || event.pointerType === 'pen'
      }

      const dismissCollapsedSelection = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null

        if (target?.closest(SELECTION_ACTIONS_SELECTOR)) {
          return
        }

        if (!selectedPassage({ messages: root.current })) {
          setSelection(null)
        }
      }

      let mouseButtons = 0

      const press = (event: MouseEvent) => {
        mouseButtons = event.buttons
      }

      const release = (event: MouseEvent) => {
        mouseButtons = event.buttons
        trackSelection({ mouseButtons })
      }

      const resetMouseButtonsOnBlur = () => {
        mouseButtons = 0
      }

      const change = () => trackSelection({ mouseButtons })
      document.addEventListener(
        'selectionchange',
        change,
      )
      document.addEventListener(
        'pointerdown',
        rememberPointerType,
        true,
      )
      document.addEventListener(
        'click',
        dismissCollapsedSelection,
        true,
      )
      document.addEventListener(
        'mousedown',
        press,
      ); document.addEventListener(
        'mouseup',
        release,
      )
      window.addEventListener(
        'blur',
        resetMouseButtonsOnBlur,
      )

      return () => {
        document.removeEventListener(
          'selectionchange',
          change,
        )
        document.removeEventListener(
          'pointerdown',
          rememberPointerType,
          true,
        )
        document.removeEventListener(
          'click',
          dismissCollapsedSelection,
          true,
        )
        document.removeEventListener(
          'mousedown',
          press,
        ); document.removeEventListener(
          'mouseup',
          release,
        )
        window.removeEventListener(
          'blur',
          resetMouseButtonsOnBlur,
        )
      }
    },
    [],
  )

  const quoteSelection = ({ passage }: { passage: CommentPassage }) => {
    quote({ text: passage.quote }); setSelection(null)
    window.getSelection()?.removeAllRanges()
    requestAnimationFrame(() => focusChatComposer({ from: root.current }))
  }

  const pill = useRef<HTMLDivElement>(null)
  // Each conversation on screen paints its own highlight, so one doesn't clear the other's.
  const [highlight] = useState(() => `othrys-comments-${++highlights}`)
  const painted = useRef<ChatComment[]>([])
  useLayoutEffect(
    () => {
      if (HIGHLIGHT_SUPPORTED && root.current) {
        paintComments({
          host: root.current,
          name: highlight,
          comments,
          previous: painted.current,
        })
        painted.current = comments
      }
    },
    [
      comments,
      entries,
      highlight,
    ],
  )
  useEffect(
    () => () => {
      clearHighlights({ name: highlight })
    },
    [highlight],
  )
  useLayoutEffect(
    () => {
      const placePillBesideLiveSelection = () => {
        const element = pill.current, host = root.current, selected = window.getSelection()

        if (!element || !host || !selected?.rangeCount || selected.isCollapsed
          || !host.contains(selected.getRangeAt(0).commonAncestorContainer)) {
          return
        }

        const range = selected.getRangeAt(0).getBoundingClientRect()
        const box = host.getBoundingClientRect(), half = element.offsetWidth / 2
        const center = range.left + range.width / 2 - box.left
        element.style.top = `${range.bottom - box.top}px`
        element.style.left = `${Math.max(
          half,
          Math.min(
            center,
            box.width - half,
          ),
        ) - half}px`
      }

      placePillBesideLiveSelection()
      const observer = new ResizeObserver(placePillBesideLiveSelection)

      if (root.current) {
        observer.observe(root.current)
      }

      return () => observer.disconnect()
    },
    [
      selection,
      entries,
    ],
  )

  const commentSelected = () => {
    if (selection) {
      addComment({ quote: selection })
    }
  }

  const quoteSelected = () => {
    if (selection) {
      quoteSelection({ passage: selection })
    }
  }

  const selectionKey = ({ event }: { event: KeyEvent<HTMLDivElement> }) => {
    const {
      key,
      shiftKey,
      altKey,
      ctrlKey,
      metaKey,
    } = event

    const modified = altKey || ctrlKey || metaKey

    if (event.nativeEvent.isComposing || modified) {
      return
    }

    const fromMessages = event.target === event.currentTarget
    const target = event.target instanceof Element ? event.target : null
    const fromSelectionAction = target?.closest(SELECTION_ACTIONS_SELECTOR)

    if (key === 'Escape' && !shiftKey && (fromMessages || fromSelectionAction)) {
      event.preventDefault()
      setSelection(null)
      const selected = window.getSelection()

      if (selectionBelongsToMessages({
        selection: selected,
        messages: root.current,
      })) {
        selected?.removeAllRanges()
      }

      event.currentTarget.closest<HTMLElement>('.thread')?.focus({ preventScroll: true })

      return
    }

    if (!fromMessages || key !== 'Enter') {
      return
    }

    const selected = selectedPassage({ messages: root.current })

    if (selected) {
      event.preventDefault()

      if (shiftKey) {
        quoteSelection({ passage: selected })
      } else {
        addComment({ quote: selected })
      }
    }
  }

  return (
    <TaskReferencesProvider references={taskReferences} openTask={openTask}>
      <style>{`.messages :is(${MESSAGE_CONTROLS}) { user-select: none; }` + comments.map(comment =>
        `::highlight(${CSS.escape(commentHighlightName({
          name: highlight,
          id: comment.id,
        }))}) { background-color: var(--comment-highlight); }`).join('')}
      </style>
      <div
        className="messages [&_:is(a,img):not(.composer-field_*)]:[-webkit-user-drag:none] relative flex flex-col gap-message-gap pt-2 in-[.chat-frame]:gap-(--chat-gap) outline-none [--message-gap:var(--chat-gap,var(--spacing-message-gap))]"
        data-highlight={highlight}
        ref={root}
        role="document"
        aria-label="Messages"
        tabIndex={-1}
        onKeyDown={event => selectionKey({ event })}
        onCopy={event => {
          const editing = event.target instanceof Element && isEditing({ target: event.target })

          if (!editing && copyMessageChips({
            selection: window.getSelection(),
            clipboard: event.clipboardData,
          })) {
            event.preventDefault()
          }
        }}
        onDragStart={event => {
          const editing = event.target instanceof Element && isEditing({ target: event.target })

          if (!editing) {
            event.preventDefault()
          }
        }}
        onPaste={event => pasteAsComment({ event })}
      >
        {entries.map(entry => {
          const messageId = entry.messageId ?? entry.id
          const activeHere = isMessageBlockKey({
            key: active,
            messageId,
          }) ? active : null
          const task = leadingTask({ entry })
          const timedTask = timings.get(entry.id)?.task
          const rowKey = entry.renderKey ?? entry.id

          return (
            <div key={rowKey} className="message-row flex flex-col gap-(--message-gap) [content-visibility:auto] [contain-intrinsic-size:auto_var(--spacing-chat-row)] [overflow-clip-margin:var(--message-gap)]">
              <MessageRow
                entry={entry}
                fold={folds?.get(entry.id)}
                trailing={trailing?.get(entry.id)}
                timing={timings.get(entry.id)}
                inline={inline?.get(entry.id)}
                hasInline={inline?.has(entry.id) ?? false}
                lead={entry.reference ? answerLeads?.get(entry.reference) : undefined}
                hasTaskReferences={taskReferences !== undefined}
                catalog={catalog}
                labelColors={labelColors}
                assistantLabel={assistantLabel}
                lookup={lookup}
                toolDetails={toolDetails}
                thinkingDetails={thinkingDetails}
                comments={rowComments.get(messageId) ?? NO_COMMENTS}
                active={activeHere}
                drafts={drafts}
                root={root}
                actions={actions}
                lookColumn={lookColumn}
                leadingTitle={task ? taskReferences?.[task]?.title : undefined}
                timingTitle={timedTask ? taskReferences?.[timedTask]?.title : undefined}
                openTask={openTask ? open : undefined}
                canRetry={retry !== undefined}
              />
            </div>
          )
        })}
        <CommentAnnotations host={root} comments={ordered} highlight={highlight} />
        {selection && (
          <div
            className="comment-pill absolute z-5 mt-1.5 flex items-center gap-0.5 p-0.75 border border-gold-line rounded-lg bg-surface shadow-comment-pill whitespace-nowrap touch:mt-7 [&_.button]:min-h-6.5 [&_.button]:py-0.5 [&_.button]:px-2 [&_.button]:gap-1.25 [&_.button]:text-meta [&_.button:first-child]:text-gold [&_kbd]:py-0 [&_kbd]:px-1 touch:[&_kbd]:hidden"
            ref={pill}
            role="group"
            aria-label="Actions by selected text"
          >
            <SelectionActionButton
              aria-label="Comment on selection"
              title="Enter, or start typing"
              act={commentSelected}
            >
              <Icon name="comment" size={ICON_SIZE.inline} />
              Comment
              <kbd>↵</kbd>
            </SelectionActionButton>
            <span className="comment-pill-divider w-px self-stretch my-1 mx-px bg-line" />
            <SelectionActionButton
              aria-label="Quote selection"
              title="Shift+Enter"
              act={quoteSelected}
            >
              <Icon name="quote" size={ICON_SIZE.inline} />
              Quote
              <kbd>⇧↵</kbd>
            </SelectionActionButton>
          </div>
        )}
        {selection && chatViewport && createPortal(
          <div
            className="comment-dock absolute inset-x-(--chat-inset) bottom-2 z-4 flex items-center gap-1.5 p-1.5 border border-gold-line rounded-xl bg-gold-wash [&_.button]:min-h-9 [&_.button]:shrink-0 [&_.button]:border-gold-line [&_.button]:bg-surface [&_.button]:px-3 [&_.button]:font-semibold [&_.button]:text-gold"
            role="group"
            aria-label="Selected text"
          >
            <span className="comment-dock-quote min-w-0 flex-1 truncate pl-1.5 text-meta text-muted">“{selection.quote}”</span>
            <SelectionActionButton act={commentSelected}>
              <Icon name="comment" size={ICON_SIZE.inline} />
              Comment
            </SelectionActionButton>
            <SelectionActionButton act={quoteSelected}>
              <Icon name="quote" size={ICON_SIZE.inline} />
              Quote
            </SelectionActionButton>
          </div>,
          chatViewport,
        )}
      </div>
    </TaskReferencesProvider>
  )
}
