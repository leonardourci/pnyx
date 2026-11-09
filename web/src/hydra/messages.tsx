import type { TurnActions } from '#hydra/conversation.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import { receiptLabel } from '#web-app/view.ts'
import { isEditing,useKeyAction,useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { CopyButton } from '#web-shared/ui/copy-button.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { SavedTaskLabels,TaskReference,TaskReferencesProvider,type TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { columnLook } from '#web-tasks/view.ts'
import {
  Fragment,useEffect,useLayoutEffect,useRef,useState,
  type ComponentProps,
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
import {
  MESSAGE_DECORATIONS,blockPassage,messageBlock,messageBlockKey,samePassage,selectedPassage,
  type CommentPassage,
} from './message-selection.ts'
import type { PnyxLookup } from './pnyx-action.ts'
import { MessageText } from './streaming.tsx'
import { roleLabel } from './trace-row.tsx'
import { TurnActionsFold,TurnFooter } from './turn-actions.tsx'

const PILL_GAP = 6
let highlights = 0

// A message the owner just sent shows at once, faded until the server records it.
export type ChatEntry = ThreadEntry & {
  sending?: boolean
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

export function Messages({
  entries,
  lookup,
  comments,
  setComments,
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
}: {
  // Sends a task message that may not have arrived again, as a new message with its own id.
  sendAgain?({
    task,
    text,
  }: {
    task: string
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
  setComments({ items }: { items: ChatComment[] }): void
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
  const ordered = orderedComments({ comments })
  const numbers = new Map(ordered.map((
    comment,
    index,
  ) => [
    comment.id,
    index + 1,
  ]))
  const lookColumn = ({ id }: { id: string }) => columnLook({
    column: lookup?.column({ ref: id }) ?? { id: id as HydraColumn['id'] },
  })
  const taskTitle = ({ id }: { id?: string }) => id ? taskReferences?.[id]?.title : undefined
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
    update,
    latest,
  } = useCommentDrafts({
    root,
    comments,
    setComments,
    notify,
    clearSelection: () => setSelection(null),
    blocks,
  })

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
        {entries.map(entry => entry.kind === 'divider' ? (
          <div
            key={entry.renderKey ?? entry.id}
            className="chat-divider"
            role="separator"
            aria-label={entry.text}
          >
            <span>{entry.text}</span>
          </div>
        ) : (
          <Fragment key={entry.renderKey ?? entry.id}>
            {folds?.get(entry.id)?.notes.length ? (
              <TurnActionsFold
                fold={{
                  tasks: [],
                  notes: folds.get(entry.id)!.notes,
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
              data-pnyx={entry.role === 'Pnyx' || undefined}
              title={entry.at && !ownMessage({ entry })
                ? new Date(entry.at).toLocaleString() : undefined}
            >
              {taskReferences && !inline?.has(entry.id) && <MessageTask entry={entry} />}
              {inline?.get(entry.id) ?? (entry.kind === 'message' ? (
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
                    const own = ordered.filter(c =>
                      c.messageId === messageId && c.offset === offset)

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
                        {own.map(comment => (
                          <MessageComment
                            key={comment.id}
                            comment={comment}
                            number={numbers.get(comment.id)!}
                            inline
                            change={({ text }) => update({
                              items: latest.current.map(c => c.id === comment.id ? {
                                ...c,
                                text,
                              } : c),
                            })}
                            remove={() => {
                              remove({ id: comment.id })
                              focusBlock({ element: blockFor({ key }) })
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
                            release={() => release({ id: comment.id })}
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
              ) : null)}
              {entry.delivery ? (
                <span className="receipt" role="status">
                  {Object.entries(entry.delivery).map(([
                    route,
                    delivery,
                  ]) => (
                    <span key={route} className={`receipt-${delivery.state}`} title={delivery.detail}>{route === 'hydra' ? 'Hydra' : 'Agent'}: {receiptLabel({ state: delivery.state })}{delivery.detail ? ` · ${delivery.detail}` : ''} </span>
                  ))}
                </span>
              ) : entry.receipt && <span className={`receipt receipt-${entry.receipt}`}>{receiptLabel({ state: entry.receipt })}</span>}
              {sendAgain && entry.task && (entry.delivery?.agent?.state ?? entry.receipt) === 'delivery_unknown' && (
                <Button
                  className="send-again"
                  aria-label="Send this message again"
                  onClick={() => sendAgain({
                    task: entry.task!,
                    text: entry.text,
                  })}
                >Send again
                </Button>
              )}
            </article>
            {ownMessage({ entry }) && !entry.continued && (
              <div className="message-meta" contentEditable={false}>
                {entry.at && (
                  <time
                    dateTime={entry.at}
                    title={`Sent ${new Date(entry.at).toLocaleDateString()}, ${clock({
                      at: entry.at,
                      seconds: true,
                    })}`}
                  >{clock({ at: entry.at })}
                  </time>
                )}
                <CopyButton
                  label="Copy message"
                  text={() => copiedText({
                    text: entry.text,
                    task: leadingTask({ entry }),
                    title: taskTitle({ id: leadingTask({ entry }) }),
                  })}
                />
              </div>
            )}
            {trailing?.get(entry.id)?.length ? (
              <TurnActionsFold
                fold={{
                  tasks: [],
                  notes: trailing.get(entry.id)!,
                }}
                lookup={lookup}
                toolDetails={toolDetails}
                thinkingDetails={thinkingDetails}
              />
            ) : null}
            {folds?.get(entry.id)?.tasks.length ? (
              <TurnActionsFold
                fold={{
                  tasks: folds.get(entry.id)!.tasks,
                  notes: [],
                }}
                lookup={lookup}
              />
            ) : null}
            {timings.has(entry.id) && (
              <TurnFooter turn={timings.get(entry.id)!} taskTitle={taskTitle} />
            )}
          </Fragment>
        ))}
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
