import { useEffect, useRef, useState, type KeyboardEvent as KeyEvent } from 'react'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import { Button, Textarea } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { isEditing, useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import {
  CARET_CSS, CARET_HOST, CARET_KEY, CARET_SUPPORTED,
  caretBox, caretInto, focusReply, latestReply, reveal,
} from './caret.ts'
import type { ChatComment } from './chat.ts'
import { receiptLabel } from './view.ts'

type Quote = Omit<ChatComment, 'id' | 'text'>
const blockKey = ({ messageId, offset }: { messageId: string; offset: number }) => `${messageId}/block-${offset}`
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
  const [selection, setSelection] = useState<Quote | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const { label, platform } = useKeyboard()
  const blocks = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-message-block]') ?? [])]
  const blockFor = ({ key }: { key: string | null }) =>
    blocks().find(e => e.dataset.messageBlock === key)

  const focusBlock = ({ element }: { element?: HTMLElement }) => {
    if (element && root.current) {
      setActive(element.dataset.messageBlock!); caretInto({ host: root.current, target: element, edge: 'start' })
    }
  }

  const quoteFrom = ({ element }: { element: HTMLElement }): Quote => ({
    messageId: element.dataset.messageId!,
    block: Number(element.dataset.blockIndex),
    offset: Number(element.dataset.blockOffset),
    quote: element.dataset.quote!,
    paragraph: element.dataset.quote!,
    at: element.dataset.messageAt,
  })

  const blockOf = ({ node }: { node?: Node | null }) =>
    (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-message-block]')

  const readSelection = (): Quote | null => {
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : null
    const text = selected?.toString().trim(), element = blockOf({ node: range?.startContainer })

    return text && element && range && root.current?.contains(range.endContainer) && !document.activeElement?.closest('.inline-comment')
      ? { ...quoteFrom({ element }), quote: text }
      : null
  }

  const addComment = ({ quote, text = '' }: { quote: Quote; text?: string }) => {
    const comment = { ...quote, id: crypto.randomUUID(), text }
    setComments({ items: [...comments, comment] }); setEditing(comment.id); setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  // With text selected in the thread, the first typed character opens a comment
  // on that selection and becomes its first character.
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
      const block = root.current?.contains(focusNode) ? blockOf({ node: focusNode }) : null
      const next = readSelection()
      const same = ({ prior }: { prior: Quote | null }) =>
        prior?.quote === next?.quote && prior?.offset === next?.offset
        && prior?.messageId === next?.messageId

      if (block && !document.activeElement?.closest('.inline-comment')) {
        setActive(block.dataset.messageBlock!)
      }

      setSelection(prior => same({ prior }) ? prior : next)
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

  // Nothing typed, pasted, dropped or undone changes the messages.
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
        event.preventDefault(); focusReply({ host })
      } else if (focused?.matches('.composer textarea') && focused.closest('.detail, .hydra-chat')?.contains(host)) {
        event.preventDefault(); caretInto({ host, target: latestReply({ host }), edge: 'start' })
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

    const selected = readSelection()

    if (key === 'Enter' && selected && !altKey && !ctrlKey && !metaKey) {
      event.preventDefault()

      if (shiftKey) {
        quote({ text: selected.quote }); setSelection(null)
        window.getSelection()?.removeAllRanges()
        requestAnimationFrame(() => focusReply({ host }))
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

    const before = caretBox(), top = (before?.top ?? 0) + scroller.scrollTop
    setTimeout(() => {
      const after = caretBox()
      const moved = after ? Math.abs(after.top + scroller.scrollTop - top) : 0
      const stuck = !after || moved < (before?.height ?? 0) / 2

      if (key === 'ArrowDown' && before && stuck && !shiftKey && !altKey && !ctrlKey && !metaKey) {
        focusReply({ host })
      } else {
        reveal({ host })
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

      setActive(element.dataset.messageBlock!); addComment({ quote: quoteFrom({ element }) })

      return true
    },
  })

  const finish = ({ comment }: { comment: ChatComment }) => {
    setEditing(null)

    if (!comment.text.trim()) {
      setComments({ items: comments.filter(c => c.id !== comment.id) })
    }

    focusBlock({ element: blockFor({ key: blockKey(comment) }) })
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
            focusReply({ host: event.currentTarget })
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
                  const key = blockKey({ messageId, offset })
                  const selected = selection?.messageId === messageId && selection.offset === offset
                  const whole: Quote = {
                    messageId, block: index, offset, quote, paragraph: quote, at: entry.at,
                  }
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
                      <Button
                        className={`block-comment-action ${selected ? 'has-selection' : ''}`}
                        aria-label="Comment on this block"
                        title={selected ? 'Enter or type to comment on your selection; Shift+Enter quotes it' : `Comment · ${label({ id: 'thread.comment' })}`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => addComment({ quote: selected ? selection : whole })}
                      >
                        <Icon name="typing" size={14} />
                        {selected
                          ? (
                            <>
                              Comment
                              <kbd>Enter</kbd>
                              <span className="small">or type · Shift+Enter quotes</span>
                            </>
                          )
                          : active === key && <kbd>{label({ id: 'thread.comment' })}</kbd>}
                      </Button>
                      {own.map(comment => (
                        <InlineComment
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

function InlineComment({ comment, editing, edit, change, finish, remove }: {
  comment: ChatComment
  editing: boolean
  edit(): void
  change({ text }: { text: string }): void
  finish(): void
  remove(): void
}) {
  return (
    <div className="inline-comment">
      <span className="eyebrow">Your comment · included in next reply</span>
      <blockquote>{comment.quote}</blockquote>
      {editing ? (
        <Textarea
          autoFocus
          onFocus={e => {
            const end = e.currentTarget.value.length
            e.currentTarget.setSelectionRange(end, end)
          }}
          aria-label="Comment on selected text"
          value={comment.text}
          onChange={e => change({ text: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault(); e.stopPropagation(); finish()
            }
          }}
        />
      ) : <p>{comment.text || 'Empty comment'}</p>}
      <div className="row">
        <Button onClick={editing ? finish : edit}>{editing ? 'Done' : 'Edit comment'}</Button>
        <Button onClick={remove}>Remove comment</Button>
      </div>
    </div>
  )
}
