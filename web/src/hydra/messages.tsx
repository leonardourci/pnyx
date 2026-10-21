import {
  useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent as PasteEvent, type KeyboardEvent as KeyEvent,
} from 'react'
import { flushSync } from 'react-dom'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { MessageText } from '../components/ui/streaming.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { TaskReference, TaskReferencesProvider, type TaskReferenceData } from '../components/ui/task-reference.tsx'
import { isEditing, useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import {
  CARET_CSS, CARET_HOST, CARET_KEY, CARET_SUPPORTED,
  caretBounds, placeMessageCaret, focusComposer, latestAgentMessage, revealCaret,
  enterNote, leaveNote, noteBetween, selectionFocus,
} from './caret.ts'
import { orderedComments, sendableComment, type ChatComment } from './chat.ts'
import { CommentAnnotations } from './comment-annotations.tsx'
import { pastedImages, uploadImages } from './image-upload.ts'
import { MessageComment } from './message-comment.tsx'
import { HIGHLIGHT_SUPPORTED, clearHighlights, commentHighlightName, commentRange, paintComments } from './comment-highlight.ts'
import {
  blockPassage, messageBlock, messageBlockKey, samePassage, selectedPassage, type CommentPassage,
} from './message-selection.ts'
import { receiptLabel } from './view.ts'

const PILL_GAP = 6
let highlights = 0

const roleLabel = ({
  role,
  assistantLabel = 'Agent',
}: {
  role: string
  assistantLabel?: string
}) => role === 'assistant' ? assistantLabel : role === 'user' ? 'You' : role

export function Messages({
  entries,
  comments,
  setComments,
  quote,
  toolDetails = true,
  thinkingDetails = true,
  taskReferences,
  openTask,
  assistantLabel,
  notify,
}: {
  notify({ text }: { text: string }): void
  openTask?({ id }: { id: string }): void
  taskReferences?: Record<string, TaskReferenceData>
  toolDetails?: boolean
  thinkingDetails?: boolean
  assistantLabel?: string
  entries: ThreadEntry[]
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

    if (event.target !== host || event.nativeEvent.isComposing) {
      return
    }

    if (key === 'Escape' && !shiftKey && !altKey && !ctrlKey && !metaKey) {
      event.preventDefault(); window.getSelection()?.removeAllRanges(); host.closest<HTMLElement>('.thread')?.focus({ preventScroll: true })

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
    const plain = !shiftKey && !altKey && !ctrlKey && !metaKey
    const line = (key === 'ArrowUp' || key === 'ArrowDown') && plain
    setTimeout(() => {
      const after = caretBounds()
      const moved = after ? Math.abs(after.top + scroller.scrollTop - top) : 0
      const stuck = !after || moved < (before?.height ?? 0) / 2
      const direction = key === 'ArrowUp' ? 'backward' : 'forward'
      // A line move that steps over a comment card stops in its note.
      const note = line && from ? noteBetween({
        host,
        from,
        to: stuck ? null : selectionFocus(),
        direction,
      }) : null

      if (note) {
        enterNote({
          note,
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
          <article
            key={entry.id}
            className={`message ${entry.kind}${/^(user|You)( · continued)?$/.test(entry.role) ? ' mine' : ''}`}
            aria-label={roleLabel({
              role: entry.role,
              assistantLabel,
            })}
            data-streaming={entry.streaming || undefined}
            title={entry.at ? new Date(entry.at).toLocaleString() : undefined}
          >
            {entry.task && taskReferences && (
              <div className="message-task">
                <span className="message-task-label">About</span>
                <TaskReference id={entry.task} />
              </div>
            )}
            {entry.kind === 'message' ? (
              <MessageText
                text={entry.text}
                streaming={entry.streaming}
                openTask={openTask}
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
                  const own = ordered.filter(c => c.messageId === messageId && c.offset === offset)

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
              <Trace entry={entry} details={entry.kind === 'tool' ? toolDetails : thinkingDetails} />
            )}
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

  return details ? <details className="trace" data-expandable="true"><summary>{summary}</summary><pre className="trace-text">{entry.text}</pre></details>
    : <div className="trace" data-expandable="false"><div className="trace-summary">{summary}</div></div>
}
