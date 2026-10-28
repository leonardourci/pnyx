import { TurnActionsFold } from './turn-actions.tsx'
import type { TurnActions } from './conversation.ts'
import {
  Fragment, useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent as PasteEvent, type KeyboardEvent as KeyEvent, type ComponentProps,
} from 'react'
import { flushSync } from 'react-dom'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import type { HydraColumn, SavedLabelColor } from '../../../src/core/model.ts'
import type { Catalog } from '../../../src/thread/catalog.ts'
import { ChatTokensContext } from '../components/ui/chat-tokens.tsx'
import { Button } from '../shared/ui/controls.tsx'
import { CopyButton } from '../shared/ui/copy-button.tsx'
import { ColumnChip } from '../components/ui/column-chip.tsx'
import { MessageText } from '../components/ui/streaming.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { TaskReference, TaskReferencesProvider, type TaskReferenceData } from '../components/ui/task-reference.tsx'
import { isEditing, useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import {
  CARET_CSS, CARET_HOST, CARET_KEY, CARET_SUPPORTED, QUESTION_CONTROLS,
  caretBounds, placeMessageCaret, focusComposer, latestAgentMessage, revealCaret,
  enterNote, leaveNote, selectionFocus, onNoteEdgeLine,
  controlBetween, leaveQuestionControl, enterControl,
} from './caret.ts'
import { clock, duration, orderedComments, ownMessage, sendableComment, turnTimings, type ChatComment, type TurnTiming } from './chat.ts'
import { CommentAnnotations } from './comment-annotations.tsx'
import { pastedImages, uploadImages } from './image-upload.ts'
import { MessageComment } from './message-comment.tsx'
import { HIGHLIGHT_SUPPORTED, clearHighlights, commentHighlightName, commentRange, paintComments } from './comment-highlight.ts'
import {
  MESSAGE_DECORATIONS, blockPassage, messageBlock, messageBlockKey, samePassage, selectedPassage,
  type CommentPassage,
} from './message-selection.ts'
import { receiptLabel } from '../app/view.ts'
import { columnLook } from './view.ts'
import { pnyxCalls, shellCommand, type PnyxCall, type PnyxLookup } from './pnyx-action.ts'

const PILL_GAP = 6
let highlights = 0

// A message the owner just sent shows at once, faded until the server records it.
export type ChatEntry = ThreadEntry & {
  sending?: boolean
  renderKey?: string
}

const roleLabel = ({
  role,
  assistantLabel = 'Agent',
}: {
  role: string
  assistantLabel?: string
}) => role === 'assistant' ? assistantLabel : role === 'user' ? 'You' : role

function ChatMessageText({
  catalog,
  colors,
  ...props
}: ComponentProps<typeof MessageText> & {
  catalog?: Catalog | null
  colors?: SavedLabelColor[]
}) {
  return (
    <ChatTokensContext.Provider
      value={{
        suggestions: catalog?.suggestions,
        colors,
      }}
    >
      <MessageText {...props} />
    </ChatTokensContext.Provider>
  )
}

export function Messages({
  entries: all,
  working,
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
  inline,
  timings,
  catalog,
  labelColors,
}: {
  catalog?: Catalog | null
  labelColors?: SavedLabelColor[]
  timings?: Map<string, TurnTiming>
  folds?: Map<string, TurnActions>
  inline?: Map<string, React.ReactNode>
  notify({ text }: { text: string }): void
  openTask?({ id }: { id: string }): void
  taskReferences?: Record<string, TaskReferenceData>
  toolDetails?: boolean
  thinkingDetails?: boolean
  assistantLabel?: string
  entries: ChatEntry[]
  // Whether the latest turn is still running, so it has no footer yet.
  working: boolean
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
  // Writes between renders build on each other, as do uploads that finish after them.
  const latest = useRef(comments)
  latest.current = comments
  const ordered = orderedComments({ comments })
  const numbers = new Map(ordered.map((
    comment,
    index,
  ) => [
    comment.id,
    index + 1,
  ]))
  const uploading = useRef(new Map<string, number>())
  const {
    entries,
    calls,
  } = pnyxCalls({
    entries: all,
    lookup,
  })
  const lookColumn = ({ id }: { id: string }) => columnLook({
    column: lookup?.column({ ref: id }) ?? { id: id as HydraColumn['id'] },
  })
  const turns = timings ?? turnTimings({
    entries,
    working,
  })
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

  const update = ({ items }: { items: ChatComment[] }) => {
    latest.current = items; setComments({ items })
  }

  const remove = ({ id }: { id: string }) =>
    update({ items: latest.current.filter(c => c.id !== id) })

  // Pending uploads keep an empty note alive until its attachment arrives.
  const release = ({ id }: { id: string }) => {
    const comment = latest.current.find(c => c.id === id)

    if (comment && !sendableComment({ comment }) && !uploading.current.get(id)) {
      remove({ id })
    }
  }

  // Rendered at once, so keys or a composition begun over the selection land in the note.
  const addComment = ({
    quote,
    text = '',
  }: {
    quote: CommentPassage
    text?: string
  }) => {
    const same = latest.current.find(c => samePassage({
      before: c,
      after: quote,
    }))
    const gap = same && text && /\S$/.test(same.text) ? ' ' : ''
    const comment = same ? {
      ...same,
      text: same.text + gap + text,
    } : {
      ...quote,
      id: crypto.randomUUID(),
      text,
    }
    flushSync(() => {
      update({
        items: same ? latest.current.map(c => c.id === same.id ? comment : c) : [
          ...latest.current,
          comment,
        ],
      }); setSelection(null)
    })
    window.getSelection()?.removeAllRanges()
    const note = root.current?.querySelector<HTMLTextAreaElement>(
      `[data-comment-id="${comment.id}"] textarea`,
    )

    if (note) {
      enterNote({
        note,
        direction: 'backward',
      })
    }

    return comment.id
  }

  const attach = async ({
    id,
    files,
  }: {
    id: string
    files: File[]
  }) => {
    const pending = uploading.current
    pending.set(
      id,
      (pending.get(id) ?? 0) + 1,
    )
    const {
      lines,
      failures,
    } = await uploadImages({ files })
    pending.set(
      id,
      pending.get(id)! - 1,
    )

    if (failures.length) {
      notify({ text: failures.join(' ') })
    }

    const comment = latest.current.find(c => c.id === id)

    if (comment && lines.length) {
      update({
        items: latest.current.map(c => c.id === id ? {
          ...c,
          images: [
            ...c.images ?? [],
            ...lines,
          ],
        } : c),
      })
    } else if (comment && !document.activeElement?.closest(`[data-comment-id="${id}"]`)) {
      release({ id })
    }
  }

  // The caret host is contenteditable for navigation, so native paste must be intercepted.
  const paste = ({ event }: { event: PasteEvent<HTMLDivElement> }) => {
    if (event.target instanceof Element && event.target.closest('.comment-card')) {
      return
    }

    event.preventDefault()
    const passage = selectedPassage({ messages: root.current })
    const text = event.clipboardData.getData('text/plain').replace(
      /\r\n/g,
      '\n',
    )
    const files = pastedImages({ clipboardData: event.clipboardData })

    if (!passage || !text && !files.length) {
      return
    }

    const id = addComment({
      quote: passage,
      text,
    })

    if (files.length) {
      void attach({
        id,
        files,
      })
    }
  }

  // A streamed reply settles into the transcript under a new id; its comments follow the passage there.
  useEffect(() => {
    const rendered = blocks(), present = new Set(rendered.map(b => b.dataset.messageId))
    let moved = false
    const items = comments.map(comment => {
      const settled = !comment.messageId.startsWith('live:') || present.has(comment.messageId)
      const block = settled ? undefined : rendered
        .filter(b => Number(b.dataset.blockOffset) === comment.offset
          && !!comment.paragraph && !!b.dataset.quote?.startsWith(comment.paragraph))
        .at(-1)

      if (!block) {
        return comment
      }

      moved = true

      return {
        ...comment,
        ...blockPassage({ block }),
        quote: comment.quote,
        start: comment.start,
      }
    })

    if (moved) {
      setComments({ items })
    }
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
        onCut={event => {
          if (!(event.target instanceof Element && isEditing({ target: event.target }))) {
            event.preventDefault(); event.clipboardData.setData(
              'text/plain',
              window.getSelection()?.toString() ?? '',
            )
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
        {entries.map(entry => (
          <Fragment key={entry.renderKey ?? entry.id}>
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
              {entry.task && taskReferences && !inline?.has(entry.id) && (
                <div className="message-task">
                  <span className="message-task-label">About</span>
                  <TaskReference id={entry.task} />
                </div>
              )}
              {inline?.get(entry.id) ?? (entry.kind === 'message' ? (
                <ChatMessageText
                  catalog={ownMessage({ entry }) ? catalog : undefined}
                  colors={labelColors}
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
                            attach={({ files }) => void attach({
                              id: comment.id,
                              files,
                            })}
                          />
                        ))}
                      </div>
                    )
                  }}
                />
              ) : (
                calls.has(entry.id)
                  ? <PnyxCallRow call={calls.get(entry.id)!} />
                  : <Trace entry={entry} details={entry.kind === 'tool' ? toolDetails : thinkingDetails} />
              ))}
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
            </article>
            {ownMessage({ entry }) && !entry.role.endsWith('continued') && (
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
                <CopyButton label="Copy message" text={() => entry.text} />
              </div>
            )}
            {folds?.has(entry.id) && <TurnActionsFold fold={folds.get(entry.id)!} />}
            {turns.has(entry.id) && <TurnFooter turn={turns.get(entry.id)!} />}
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

function TurnFooter({ turn }: { turn: TurnTiming }) {
  const took = duration({ ms: Date.parse(turn.end) - Date.parse(turn.start) })
  const started = clock({
    at: turn.start,
    seconds: true,
  })

  return (
    <div className="turn-foot" contentEditable={false}>
      {turn.reply && <CopyButton label="Copy reply" text={() => turn.reply} />}
      {turn.latest
        ? <time dateTime={turn.end} title={`Worked for ${took} · started ${started}`}>{clock({ at: turn.end })}</time>
        : (
          <span
            title={`Started ${started} · stopped ${clock({
              at: turn.end,
              seconds: true,
            })}`}
          >Worked for {took}
          </span>
        )}
    </div>
  )
}

export function SentencePart({ part }: { part: PnyxCall['sentence'][number] }) {
  if (typeof part === 'string') {
    return part
  }

  if ('column' in part) {
    return <ColumnChip {...columnLook({ column: part.column })} label={part.label} />
  }

  return (
    // A click on the chip opens the task without folding the row.
    <span onClick={event => event.preventDefault()}>
      <TaskReference id={part.task}>{part.label}</TaskReference>
    </span>
  )
}

// Pnyx's own commands read as what they did; the command itself is one click away.
function PnyxCallRow({ call }: { call: PnyxCall }) {
  return (
    <details className="trace pnyx-call" data-expandable="true" data-failed={!!call.failed || undefined}>
      <summary>
        <Icon name="tool" size={14} />
        <span className="pnyx-sentence">
          {call.sentence.map((
            part,
            index,
          ) => <SentencePart key={index} part={part} />)}
          {call.failed && <span className="pnyx-failed"> · failed: {call.failed}</span>}
        </span>
        <CopyButton className="trace-copy" label="Copy command" text={() => call.command} />
      </summary>
      <pre className="trace-text">{call.output ? `${call.command}\n\n${call.output}` : call.command}</pre>
    </details>
  )
}

function Trace({
  entry,
  details,
}: {
  entry: ThreadEntry
  details: boolean
}) {
  const firstLine = entry.text.split(
    '\n',
    1,
  )[0]?.slice(
    0,
    200,
  )
  const label = entry.kind === 'thinking' ? 'Thinking' : roleLabel(entry)
  const summary = (
    <>
      <Icon name={entry.kind} size={14} />
      <strong>{label}</strong>
      <span>{firstLine}</span>
    </>
  )

  const copy = entry.kind === 'tool' && <CopyButton className="trace-copy" label="Copy" text={() => shellCommand({ text: entry.text }) ?? entry.text} />

  return details ? <details className="trace" data-expandable="true"><summary>{summary}{copy}</summary><pre className="trace-text">{entry.text}</pre></details>
    : <div className="trace" data-expandable="false"><div className="trace-summary">{summary}{copy}</div></div>
}
