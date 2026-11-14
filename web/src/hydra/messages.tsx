import { MeasuredList } from '#web-shared/ui/measured-list.tsx'
import type { ChatDrafts } from './chat-drafts.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { upgradeMilestoneIcon } from '#upgrade/model.ts'
import { skillIcon } from './skill-icons.ts'
import type { TurnActions } from '#hydra/conversation.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { isEditing,useKeyAction,useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { Button,InlineButton } from '#web-shared/ui/controls.tsx'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SavedTaskLabels,TaskReference,TaskReferencesProvider,type TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { columnLook } from '#web-tasks/view.ts'
import {
  memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,
  type ComponentProps,type RefObject,type ReactNode,
  type KeyboardEvent as KeyEvent,
} from 'react'
import {
  CARET_CSS,CARET_HOST,CARET_KEY,CARET_SUPPORTED,QUESTION_CONTROLS,
  caretBounds,
  controlBetween,
  enterControl,
  focusComposer,latestAgentMessage,
  leaveNote,
  leaveQuestionControl,
  onNoteEdgeLine,
  placeMessageCaret,
  revealCaret,
  selectionFocus,
} from './caret.ts'
import { ChatTokensContext } from './chat-token-text.tsx'
import { clock,copiedText,orderedComments,type ChatComment } from './chat.ts'
import { leadingTask, ownMessage, type TurnTiming } from '#hydra/chat-messages.ts'
import { copyMessageChips } from './clipboard.ts'
import { CommentAnnotations } from './comment-annotations.tsx'
import { useCommentDrafts } from './comment-drafts.ts'
import { HIGHLIGHT_SUPPORTED,clearHighlights,commentHighlightName,commentRange,paintComments } from './comment-highlight.ts'
import { revealComment } from './comment-reveal.ts'
import { MessageComment } from './message-comment.tsx'
import { MessageReceipt } from './message-receipt.tsx'
import { sentTime } from './receipt-lines.ts'
import {
  MESSAGE_DECORATIONS,blockPassage,isMessageBlockKey,messageBlock,messageBlockKey,samePassage,
  selectedPassage,type CommentPassage,
} from './message-selection.ts'
import type { PnyxLookup } from './pnyx-action.ts'
import { MessageText } from './streaming.tsx'
import { AnswerLeadHead, openFoldedQuestion } from './answer-lead.tsx'
import type { AnswerLead } from './answer-leads.ts'
import { roleLabel } from './trace-row.tsx'
import { TurnActionsFold,TurnFooter } from './turn-actions.tsx'

const PILL_GAP = 6
let highlights = 0

// A message the owner just sent shows at once, faded until the server records it.
export type ChatEntry = ThreadEntry & {
  sending?: boolean
  // Why the owner's message was not sent; it stays with a retry.
  unsent?: string
  renderKey?: string
}

function MessageTask({ entry }: { entry: ChatEntry }) {
  const task = leadingTask({ entry })

  return task ? (
    <span className="message-lead">
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

  return name ? <Icon name={name} size={14} /> : null
}

interface RowComment {
  comment: ChatComment
  number: number
}
interface MessageActions {
  remove({ id }: { id: string }): void
  release({ id }: { id: string }): void
  focus({ key }: { key: string }): void
  sendNow?({
    id,
    task,
  }: {
    id: string
    task?: string
  }): void
  retry?({ id }: { id: string }): void
  sendAgain?({
    task,
    text,
  }: {
    task?: string
    text: string
  }): void
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
  canSendAgain,
  canRetry,
  canSendNow,
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
  lookup: PnyxLookup
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
  canSendAgain: boolean
  canRetry: boolean
  canSendNow: boolean
}) {
  const state = entry.delivery?.agent?.state ?? entry.receipt
  const stopped = state === 'failed' && (entry.delivery?.agent?.detail ?? entry.waiting) === 'stopped'
  const canResend = canSendAgain && (stopped && !entry.sentAgain || entry.task && state === 'delivery_unknown')
  const deliverNow = canSendNow && state === 'queued'
  const sentAt = sentTime({ entry })

  return entry.kind === 'divider' ? (
    <div
      className="chat-divider"
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
      <article
        data-entry-id={entry.id}
        className={`message ${entry.kind}${ownMessage({ entry }) ? ' mine' : ''}`}
        aria-label={roleLabel({
          role: entry.role,
          assistantLabel,
        })}
        data-streaming={entry.streaming || undefined}
        data-sending={entry.sending || undefined}
        data-unsent={entry.unsent !== undefined || undefined}
        data-pnyx={entry.role === 'Pnyx' || undefined}
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
            savedTaskLabels={entry.role === 'Pnyx'}
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
                  className="message-block"
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
                      remove={() => {
                        actions.current.remove({ id: comment.id })
                        actions.current.focus({ key })
                      }}
                      leave={({
                        note,
                        direction,
                      }) => root.current && leaveNote({
                        passage: commentRange({
                          host: root.current,
                          comment,
                        })?.getClientRects()[0],
                        host: root.current,
                        note,
                        direction,
                      })}
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
      </article>
      {ownMessage({ entry }) && !entry.continued && (
        <div className="message-meta" contentEditable={false}>
          <MessageReceipt entry={entry} />
          {deliverNow && (
            <InlineButton
              onClick={() => actions.current.sendNow?.({
                id: entry.replyId ?? entry.reference ?? entry.id,
                task: entry.replyId ? entry.task : undefined,
              })}
            >
              Send now
            </InlineButton>
          )}
          {canResend && (
            <InlineButton
              aria-label="Send this message again"
              onClick={() => actions.current.sendAgain?.({
                task: entry.replyId ? entry.task : undefined,
                text: entry.text,
              })}
            >
              Send again
            </InlineButton>
          )}
          {entry.unsent !== undefined && (
            <span className="unsent" role="alert">
              <Icon name="error" size={14} />Not sent · {entry.unsent}
            </span>
          )}
          {entry.unsent !== undefined && canRetry && (
            <InlineButton onClick={() => actions.current.retry?.({ id: entry.id })}>
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
        </div>
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

export function Messages({
  entries,
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
  sendAgain,
  sendNow,
  sendableNow,
  retry,
  answerLeads,
}: {
  sendNow?({
    id,
    task,
  }: {
    id: string
    task?: string
  }): void
  // Whether Send now can work for this message: its agent is Pnyx's own and running a turn.
  sendableNow?({ entry }: { entry: ChatEntry }): boolean
  retry?({ id }: { id: string }): void
  // The question each answering owner message carries, by message id.
  answerLeads?: Map<string, AnswerLead>
  // Sends a task message that may not have arrived again, as a new message with its own id.
  sendAgain?({
    task,
    text,
  }: {
    task?: string
    text: string
  }): void
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
  lookup: PnyxLookup
  comments: ChatComment[]
  drafts: ChatDrafts
  quote({ text }: { text: string }): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [
    active,
    setActive,
  ] = useState<string | null>(null)
  const [
    selection,
    setSelection,
  ] = useState<CommentPassage | null>(null)
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
  const lookColumn = useCallback(
    ({ id }: { id: string }) => columnLook({
      column: lookup.column({ ref: id }) ?? { id: id as HydraColumn['id'] },
    }),
    [lookup],
  )
  const currentOpen = useRef(openTask)
  currentOpen.current = openTask
  const open = useCallback(
    ({ id }: { id: string }) => currentOpen.current?.({ id }),
    [],
  )

  const { platform } = useKeyboard()
  const blocks = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-message-block]') ?? [])]
  const blockFor = ({ key }: { key: string | null }) =>
    blocks().find(e => e.dataset.messageBlock === key)

  const focusBlock = ({ element }: { element?: HTMLElement }) => {
    if (element && root.current) {
      setActive(element.dataset.messageBlock!); placeMessageCaret({
        host: root.current,
        target: element,
        edge: 'start',
      })
    }
  }

  const {
    addComment,
    paste,
    remove,
    release,
  } = useCommentDrafts({
    root,
    drafts,
    notify,
    clearSelection: () => setSelection(null),
    blocks,
  })

  const handlers: MessageActions = {
    remove,
    release,
    focus: ({ key }) => focusBlock({ element: blockFor({ key }) }),
    retry,
    sendAgain,
    sendNow,
  }
  const actions = useRef(handlers)
  actions.current = handlers

  useEffect(() => {
    if (!selection) {
      return
    }

    const typeComment = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const selected = window.getSelection()

      if (event.defaultPrevented || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey ||
        event.key.length !== 1 || (target && isEditing({ target })) ||
        !selected?.toString().trim() || !root.current?.contains(selected.anchorNode) ||
        !root.current.contains(selected.focusNode)) {
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
      typeComment,
      true,
    )

    return () => window.removeEventListener(
      'keydown',
      typeComment,
      true,
    )
  })

  // Mouse selections count on mouseup so the comment offer never moves text under the pointer.
  useEffect(
    () => {
      const track = ({ buttons }: { buttons: number }) => {
        if (buttons) {
          return
        }

        const focusNode = window.getSelection()?.focusNode ?? null
        const block = root.current?.contains(focusNode) ? messageBlock({ node: focusNode }) : null
        const next = selectedPassage({ messages: root.current })

        if (block && !document.activeElement?.closest('.comment-card')) {
          setActive(block.dataset.messageBlock!)
        }

        setSelection(prior => samePassage({
          before: prior,
          after: next,
        }) ? prior : next)
      }

      let buttons = 0

      const press = (event: MouseEvent) => {
        buttons = event.buttons
      }

      const release = (event: MouseEvent) => {
        buttons = event.buttons; track({ buttons })
      }

      // A drag that ends outside the window never sends its mouseup here.
      const reset = () => {
        buttons = 0
      }

      const change = () => track({ buttons })
      document.addEventListener(
        'selectionchange',
        change,
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
        reset,
      )

      return () => {
        document.removeEventListener(
          'selectionchange',
          change,
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
          reset,
        )
      }
    },
    [],
  )

  useEffect(
    () => {
      const host = root.current

      const keep = (event: InputEvent) => {
        if (event.target !== host) {
          return
        }

        event.preventDefault()
        const passage = selectedPassage({ messages: host })
        const text = event.data ?? event.dataTransfer?.getData('text/plain')

        if (passage && text && /^insert(Text|ReplacementText)$/.test(event.inputType)) {
          addComment({
            quote: passage,
            text,
          })
        }
      }

      host?.addEventListener(
        'beforeinput',
        keep,
      )

      return () => host?.removeEventListener(
        'beforeinput',
        keep,
      )
    },
  )

  useEffect(
    () => {
      const jump = (event: KeyboardEvent) => {
        const host = root.current, focused = document.activeElement
        const mod = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

        if (!host || !mod || event.shiftKey || event.altKey || event.repeat || event.isComposing ||
        event.defaultPrevented || event.key.toLowerCase() !== 'l') {
          return
        }

        if (focused === host) {
          event.preventDefault(); focusComposer({ host })
        } else if (focused?.matches('.composer textarea') && focused.closest('.detail, .hydra-chat')?.contains(host)) {
          event.preventDefault(); placeMessageCaret({
            host,
            target: latestAgentMessage({ host }),
            edge: 'start',
          })
        }
      }

      window.addEventListener(
        'keydown',
        jump,
      )

      return () => window.removeEventListener(
        'keydown',
        jump,
      )
    },
    [platform],
  )

  const quoteSelection = ({ passage }: { passage: CommentPassage }) => {
    quote({ text: passage.quote }); setSelection(null)
    window.getSelection()?.removeAllRanges()
    requestAnimationFrame(() => root.current && focusComposer({ host: root.current }))
  }

  // The pill floats under the selection, inside the messages so it scrolls with them and moves no text.
  const pill = useRef<HTMLDivElement>(null)
  // Each conversation on screen paints its own highlight, so one doesn't clear the other's.
  const [highlight] = useState(() => `pnyx-comments-${++highlights}`)
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
      const place = () => {
        const element = pill.current, host = root.current, selected = window.getSelection()

        if (!element || !host || !selected?.rangeCount) {
          return
        }

        const range = selected.getRangeAt(0).getBoundingClientRect()
        const box = host.getBoundingClientRect(), half = element.offsetWidth / 2
        const center = range.left + range.width / 2 - box.left
        element.style.top = `${range.bottom - box.top + PILL_GAP}px`
        element.style.left = `${Math.max(
          half,
          Math.min(
            center,
            box.width - half,
          ),
        ) - half}px`
      }

      place()
      const observer = new ResizeObserver(place)

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

  const caretKey = ({ event }: { event: KeyEvent<HTMLDivElement> }) => {
    const host = event.currentTarget, {
      key,
      shiftKey,
      altKey,
      ctrlKey,
      metaKey,
    } = event

    if (event.nativeEvent.isComposing) {
      return
    }

    const plain = !shiftKey && !altKey && !ctrlKey && !metaKey
    const control = event.target instanceof HTMLElement ? event.target : null

    if (control !== host) {
      if (!plain || !control?.matches(QUESTION_CONTROLS)) {
        return
      }

      if (key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); focusComposer({ host })
      } else if (key === 'ArrowUp' || key === 'ArrowDown') {
        const direction = key === 'ArrowUp' ? 'backward' : 'forward'

        if (control instanceof HTMLTextAreaElement && !onNoteEdgeLine({
          note: control,
          direction,
        })) {
          return
        }

        event.preventDefault(); event.stopPropagation(); leaveQuestionControl({
          host,
          control,
          direction,
        })
      }

      return
    }

    if (key === 'Escape' && !shiftKey && !altKey && !ctrlKey && !metaKey) {
      const node = window.getSelection()?.focusNode
      const element = node instanceof Element ? node : node?.parentElement
      event.preventDefault()
      window.getSelection()?.removeAllRanges()

      if (element?.closest('.chat-decision')) {
        focusComposer({ host })
      } else {
        host.closest<HTMLElement>('.thread')?.focus({ preventScroll: true })
      }

      return
    }

    const selected = selectedPassage({ messages: root.current })

    if (key === 'Enter' && selected && !altKey && !ctrlKey && !metaKey) {
      event.preventDefault()

      if (shiftKey) {
        quoteSelection({ passage: selected })
      } else {
        addComment({ quote: selected })
      }

      return
    }

    if (!CARET_KEY.test(key)) {
      return
    }

    const scroller = host.closest('.thread')

    if (!scroller) {
      return
    }

    const before = caretBounds(), top = (before?.top ?? 0) + scroller.scrollTop
    const from = selectionFocus()
    const line = (key === 'ArrowUp' || key === 'ArrowDown') && plain
    setTimeout(() => {
      const after = caretBounds()
      const moved = after ? Math.abs(after.top + scroller.scrollTop - top) : 0
      const stuck = !after || moved < (before?.height ?? 0) / 2
      const direction = key === 'ArrowUp' ? 'backward' : 'forward'
      const control = line && from ? controlBetween({
        host,
        from,
        to: stuck ? null : selectionFocus(),
        direction,
      }) : null

      if (control) {
        enterControl({
          control,
          direction,
        })
      } else if (key === 'ArrowDown' && before && stuck && line) {
        focusComposer({ host })
      } else {
        revealCaret({ host })
      }
    })
  }

  const step = ({ to }: { to: 'up' | 'down' | 'first' | 'last' }) => {
    const elements = blocks()

    if (!elements.length) {
      return false
    }

    const n = elements.findIndex(e => e.dataset.messageBlock === active)
    const next = to === 'first' ? 0 : to === 'last' ? elements.length - 1
      : n < 0 ? to === 'up' ? elements.length - 1 : 0 : n + (to === 'up' ? -1 : 1)
    focusBlock({
      element: elements[Math.max(
        0,
        Math.min(
          elements.length - 1,
          next,
        ),
      )],
    })

    return true
  }

  const pageStep = ({
    target,
    direction,
  }: {
    target: HTMLElement
    direction: number
  }) => {
    if (!root.current?.closest('.thread')?.contains(target)) {
      return false
    }

    const scroller = root.current.closest<HTMLElement>('.hydra-messages, .column-cards')
    scroller?.scrollBy({ top: scroller.clientHeight * direction })

    return !!scroller
  }

  useKeyAction({
    id: 'thread.pageUp',
    handler: ({ context }) => pageStep({
      target: context.target,
      direction: -1,
    }),
  })
  useKeyAction({
    id: 'thread.pageDown',
    handler: ({ context }) => pageStep({
      target: context.target,
      direction: 1,
    }),
  })
  useKeyAction({
    id: 'thread.up',
    handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'up' }),
  })
  useKeyAction({
    id: 'thread.down',
    handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'down' }),
  })
  useKeyAction({
    id: 'thread.first',
    handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'first' }),
  })
  useKeyAction({
    id: 'thread.last',
    handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'last' }),
  })
  useKeyAction({
    id: 'thread.comment',
    handler: ({ context }) => {
      if (!root.current?.closest('.thread')?.contains(context.target)) {
        return false
      }

      const element = blockFor({ key: active }) ?? blocks().at(-1)

      if (!element) {
        return false
      }

      setActive(element.dataset.messageBlock!)
      addComment({ quote: blockPassage({ block: element }) })

      return true
    },
  })

  return (
    <TaskReferencesProvider references={taskReferences} openTask={openTask}>
      <style>{CARET_CSS + comments.map(comment =>
        `::highlight(${CSS.escape(commentHighlightName({
          name: highlight,
          id: comment.id,
        }))}) { background-color: var(--comment-highlight); }`).join('')}
      </style>
      <div
        className="messages"
        data-highlight={highlight}
        ref={root}
        contentEditable={CARET_SUPPORTED}
        suppressContentEditableWarning
        {...{ [CARET_HOST]: '' }}
        role="document"
        aria-label="Messages"
        aria-readonly="true"
        tabIndex={-1}
        inputMode="none"
        spellCheck={false}
        data-gramm="false"
        onKeyDown={event => caretKey({ event })}
        onCopy={event => {
          const editing = event.target instanceof Element && isEditing({ target: event.target })

          if (!editing && copyMessageChips({
            selection: window.getSelection(),
            clipboard: event.clipboardData,
          })) {
            event.preventDefault()
          }
        }}
        onCut={event => {
          if (event.target instanceof Element && isEditing({ target: event.target })) {
            return
          }

          event.preventDefault()

          if (!copyMessageChips({
            selection: window.getSelection(),
            clipboard: event.clipboardData,
          })) {
            event.clipboardData.setData(
              'text/plain',
              window.getSelection()?.toString() ?? '',
            )
          }
        }}
        onDragStart={event => {
          const editing = event.target instanceof Element && isEditing({ target: event.target })

          if (!editing) {
            copyMessageChips({
              selection: window.getSelection(),
              clipboard: event.dataTransfer,
            })
          }
        }}
        onPaste={event => paste({ event })}
        // A composition can't be cancelled; over a selection it goes into the new comment's note.
        onCompositionStart={event => {
          if (event.target !== event.currentTarget) {
            return
          }

          const passage = selectedPassage({ messages: event.currentTarget })

          if (passage) {
            addComment({ quote: passage })
          } else {
            focusComposer({ host: event.currentTarget })
          }
        }}
      >
        <MeasuredList
          items={entries}
          itemKey={({ item }) => item.renderKey ?? item.id}
          render={({ item: entry }) => {
            const messageId = entry.messageId ?? entry.id
            const activeHere = isMessageBlockKey({
              key: active,
              messageId,
            }) ? active : null
            const task = leadingTask({ entry })
            const timedTask = timings.get(entry.id)?.task

            return (
              <MessageRow
                key={entry.renderKey ?? entry.id}
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
                canSendAgain={sendAgain !== undefined}
                canRetry={retry !== undefined}
                canSendNow={sendNow !== undefined && (sendableNow?.({ entry }) ?? true)}
              />
            )
          }}
        />
        <CommentAnnotations host={root} comments={ordered} highlight={highlight} />
        {selection && (
          <div
            className="comment-pill"
            ref={pill}
            contentEditable={false}
            onMouseDown={e => e.preventDefault()}
          >
            <Button
              aria-label="Comment on selection"
              title="Enter, or start typing"
              onClick={() => addComment({ quote: selection })}
            >
              <Icon name="comment" size={14} />
              Comment
              <kbd>↵</kbd>
            </Button>
            <span className="comment-pill-divider" />
            <Button
              aria-label="Quote selection"
              title="Shift+Enter"
              onClick={() => quoteSelection({ passage: selection })}
            >
              <Icon name="quote" size={14} />
              Quote
              <kbd>⇧↵</kbd>
            </Button>
          </div>
        )}
      </div>
    </TaskReferencesProvider>
  )
}
