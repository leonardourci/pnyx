import { useEffect, useRef, useState, type KeyboardEvent as KeyEvent } from 'react'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { isEditing, useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import {
  CARET_CSS, CARET_HOST, CARET_KEY, CARET_SUPPORTED,
  caretBounds, placeMessageCaret, focusComposer, latestAgentMessage, revealCaret,
} from './caret.ts'
import type { ChatComment } from './chat.ts'
import { MessageComment } from './message-comment.tsx'
import { blockPassage, messageBlock, messageBlockKey, samePassage, selectedPassage, type CommentPassage } from './message-selection.ts'
import { receiptLabel } from './view.ts'

const roleLabel = ({ role }: { role: string }) => role === 'assistant' ? 'Agent' : role === 'user' ? 'You' : role

export function Messages({
  entries, comments, setComments, quote, toolDetails = true, thinkingDetails = true,
}: {
  toolDetails?: boolean
  thinkingDetails?: boolean
  entries: ThreadEntry[]
  comments: ChatComment[]
  setComments({ items }: { items: ChatComment[] }): void
  quote({ text }: { text: string }): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [selection, setSelection] = useState<CommentPassage | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const { platform } = useKeyboard()
  const blocks = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-message-block]') ?? [])]
  const blockFor = ({ key }: { key: string | null }) =>
    blocks().find(e => e.dataset.messageBlock === key)

  const focusBlock = ({ element }: { element?: HTMLElement }) => {
    if (element && root.current) {
      setActive(element.dataset.messageBlock!); placeMessageCaret({ host: root.current, target: element, edge: 'start' })
    }
  }

  const addComment = ({ quote, text = '' }: { quote: CommentPassage; text?: string }) => {
    const comment = { ...quote, id: crypto.randomUUID(), text }
    setComments({ items: [...comments, comment] }); setEditing(comment.id); setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

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
      addComment({ quote: selection, text: event.key })
    }

    window.addEventListener('keydown', typeComment, true)

    return () => window.removeEventListener('keydown', typeComment, true)
  })

  // Mouse selections count on mouseup so the comment offer never moves text under the pointer.
  useEffect(() => {
    const track = ({ buttons }: { buttons: number }) => {
      if (buttons) {
        return
      }

      const focusNode = window.getSelection()?.focusNode ?? null
      const block = root.current?.contains(focusNode) ? messageBlock({ node: focusNode }) : null
      const next = selectedPassage({ messages: root.current })

      if (block && !document.activeElement?.closest('.inline-comment')) {
        setActive(block.dataset.messageBlock!)
      }

      setSelection(prior => samePassage({ before: prior, after: next }) ? prior : next)
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
    document.addEventListener('selectionchange', change)
    document.addEventListener('mousedown', press); document.addEventListener('mouseup', release)
    window.addEventListener('blur', reset)

    return () => {
      document.removeEventListener('selectionchange', change)
      document.removeEventListener('mousedown', press); document.removeEventListener('mouseup', release)
      window.removeEventListener('blur', reset)
    }
  }, [])

  useEffect(() => {
    const host = root.current

    const keep = (event: InputEvent) => {
      if (event.target === host) {
        event.preventDefault()
      }
    }

    host?.addEventListener('beforeinput', keep)

    return () => host?.removeEventListener('beforeinput', keep)
  }, [])

  useEffect(() => {
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
        event.preventDefault(); placeMessageCaret({ host, target: latestAgentMessage({ host }), edge: 'start' })
      }
    }

    window.addEventListener('keydown', jump)

    return () => window.removeEventListener('keydown', jump)
  }, [platform])

  const caretKey = ({ event }: { event: KeyEvent<HTMLDivElement> }) => {
    const host = event.currentTarget, { key, shiftKey, altKey, ctrlKey, metaKey } = event

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
        quote({ text: selected.quote }); setSelection(null)
        window.getSelection()?.removeAllRanges()
        requestAnimationFrame(() => focusComposer({ host }))
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
    setTimeout(() => {
      const after = caretBounds()
      const moved = after ? Math.abs(after.top + scroller.scrollTop - top) : 0
      const stuck = !after || moved < (before?.height ?? 0) / 2

      if (key === 'ArrowDown' && before && stuck && !shiftKey && !altKey && !ctrlKey && !metaKey) {
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
    focusBlock({ element: elements[Math.max(0, Math.min(elements.length - 1, next))] })

    return true
  }

  const pageStep = ({ target, direction }: { target: HTMLElement; direction: number }) => {
    if (!root.current?.closest('.thread')?.contains(target)) {
      return false
    }

    const scroller = root.current.closest<HTMLElement>('.hydra-messages, .column-cards')
    scroller?.scrollBy({ top: scroller.clientHeight * direction })

    return !!scroller
  }

  useKeyAction({ id: 'thread.pageUp', handler: ({ context }) => pageStep({ target: context.target, direction: -1 }) })
  useKeyAction({ id: 'thread.pageDown', handler: ({ context }) => pageStep({ target: context.target, direction: 1 }) })
  useKeyAction({ id: 'thread.up', handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'up' }) })
  useKeyAction({ id: 'thread.down', handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'down' }) })
  useKeyAction({ id: 'thread.first', handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'first' }) })
  useKeyAction({ id: 'thread.last', handler: ({ context }) => !!root.current?.closest('.thread')?.contains(context.target) && step({ to: 'last' }) })
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

  const finish = ({ comment }: { comment: ChatComment }) => {
    setEditing(null)

    if (!comment.text.trim()) {
      setComments({ items: comments.filter(c => c.id !== comment.id) })
    }

    focusBlock({ element: blockFor({ key: messageBlockKey(comment) }) })
  }

  return (
    <>
      <style>{CARET_CSS}</style>
      <div
        className="messages"
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
            event.preventDefault(); event.clipboardData.setData('text/plain', window.getSelection()?.toString() ?? '')
          }
        }}
        onCompositionStart={event => {
          if (event.target === event.currentTarget) {
            focusComposer({ host: event.currentTarget })
          }
        }}
      >
        {entries.map(entry => (
          <article
            key={entry.id}
            className={`message ${entry.kind}${entry.role === 'user' || entry.role === 'You' ? ' mine' : ''}`}
            aria-label={roleLabel(entry)}
            title={entry.at ? new Date(entry.at).toLocaleString() : undefined}
          >
            {entry.kind === 'message' ? (
              <Markdown
                text={entry.text}
                block={({ index, offset: local, quote, children }) => {
                  const messageId = entry.messageId ?? entry.id
                  const offset = (entry.part ?? 0) + local
                  const key = messageBlockKey({ messageId, offset })
                  const selected = selection?.messageId === messageId && selection.offset === offset
                  const own = comments.filter(c => c.messageId === messageId && c.offset === offset)

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
                      {selected && (
                        <Button
                          className="block-comment-action has-selection"
                          aria-label="Comment on this block"
                          title="Enter or type to comment on your selection; Shift+Enter quotes it"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => addComment({ quote: selection })}
                        >
                          <Icon name="typing" size={14} />
                          Comment
                          <kbd>Enter</kbd>
                          <span className="small">or type · Shift+Enter quotes</span>
                        </Button>
                      )}
                      {own.map(comment => (
                        <MessageComment
                          key={comment.id}
                          comment={comment}
                          editing={editing === comment.id}
                          edit={() => setEditing(comment.id)}
                          change={({ text }) => setComments({
                            items: comments.map(c => c.id === comment.id ? { ...c, text } : c),
                          })}
                          finish={() => finish({ comment })}
                          remove={() => {
                            setComments({ items: comments.filter(c => c.id !== comment.id) })
                            focusBlock({ element: blockFor({ key }) })
                          }}
                        />
                      ))}
                    </div>
                  )
                }}
              />
            ) : (
              <Trace entry={entry} details={entry.kind === 'tool' ? toolDetails : thinkingDetails} />
            )}
            {entry.receipt && <span className={`receipt receipt-${entry.receipt}`}>{receiptLabel({ state: entry.receipt })}</span>}
          </article>
        ))}
      </div>
    </>
  )
}

function Trace({ entry, details }: { entry: ThreadEntry; details: boolean }) {
  const summary = <><Icon name={entry.kind} size={14} /><strong>{entry.kind === 'thinking' ? 'Thinking' : roleLabel(entry)}</strong><span>{entry.text.split('\n', 1)[0]?.slice(0, 200)}</span></>

  return details ? <details className="trace" data-expandable="true"><summary>{summary}</summary><pre className="trace-text">{entry.text}</pre></details>
    : <div className="trace" data-expandable="false"><div className="trace-summary">{summary}</div></div>
}
