import { useEffect, useRef, useState } from 'react'
import type { ThreadEntry } from '../../../src/thread/read.ts'
import { Button, Textarea } from '../components/ui/controls.tsx'
import { Markdown } from '../components/ui/markdown.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { useKeyAction, useKeyboard } from '../keyboard/registry.tsx'
import type { ChatComment } from './chat.ts'
import { receiptLabel } from './view.ts'

type Quote = Omit<ChatComment, 'id' | 'text'>
const blockKey = ({ messageId, offset }: { messageId: string; offset: number }) => `${messageId}/block-${offset}`
const roleLabel = ({ role }: { role: string }) => role === 'assistant' ? 'Agent' : role === 'user' ? 'You' : role

// Thread messages: Markdown for prompts and replies, dim text for traces. Each
// Markdown block can be selected with the keyboard and commented on.
export function Messages({ entries, comments, setComments }: {
  entries: ThreadEntry[]
  comments: ChatComment[]
  setComments(comments: ChatComment[]): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [selection, setSelection] = useState<Quote | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const { label } = useKeyboard()
  const blocks = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-message-block]') ?? [])]
  const blockFor = ({ key }: { key: string | null }) =>
    blocks().find(e => e.dataset.messageBlock === key)

  const focusBlock = ({ element }: { element?: HTMLElement }) => {
    if (element) {
      setActive(element.dataset.messageBlock!); element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'nearest' })
    }
  }

  const quoteFrom = ({ element }: { element: HTMLElement }): Quote => ({
    messageId: element.dataset.messageId!,
    block: Number(element.dataset.blockIndex),
    offset: Number(element.dataset.blockOffset),
    quote: element.dataset.quote!,
  })

  const addComment = ({ quote, text = '' }: { quote: Quote; text?: string }) => {
    const comment = { ...quote, id: crypto.randomUUID(), text }
    setComments([...comments, comment]); setEditing(comment.id); setSelection(null)
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
        event.key.length !== 1 || target?.closest('input,textarea,[contenteditable=true]') ||
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

  useKeyAction('thread.up', () => step({ to: 'up' }))
  useKeyAction('thread.down', () => step({ to: 'down' }))
  useKeyAction('thread.first', () => step({ to: 'first' }))
  useKeyAction('thread.last', () => step({ to: 'last' }))
  useKeyAction('thread.comment', () => {
    const element = blockFor({ key: active }) ?? blocks().at(-1)

    if (!element) {
      return false
    }

    setActive(element.dataset.messageBlock!); addComment({ quote: quoteFrom({ element }) })

    return true
  })

  const finish = ({ comment }: { comment: ChatComment }) => {
    setEditing(null)

    if (!comment.text.trim()) {
      setComments(comments.filter(c => c.id !== comment.id))
    }

    focusBlock({ element: blockFor({ key: blockKey(comment) }) })
  }

  return (
    <div
      className="messages"
      ref={root}
      onMouseUp={() => {
        const selected = window.getSelection()
        const text = selected?.toString().trim()
        const range = selected?.rangeCount ? selected.getRangeAt(0) : null
        const start = range?.startContainer
        const element = (start instanceof Element ? start : start?.parentElement)?.closest<HTMLElement>('[data-message-block]')

        if (text && element && range && root.current?.contains(range.endContainer) && !document.activeElement?.closest('.inline-comment')) {
          setSelection({ ...quoteFrom({ element }), quote: text })
          setActive(element.dataset.messageBlock!)
        } else {
          setSelection(null)
        }
      }}
    >
      {entries.map(entry => (
        <article key={entry.id} className={`message ${entry.kind}${entry.role === 'user' || entry.role === 'You' ? ' mine' : ''}`}>
          <div className="message-head">
            <strong>
              <Icon name={entry.kind === 'message' ? 'agent' : entry.kind} size={14} />
              {roleLabel(entry)}
            </strong>
            <time>{entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
          </div>
          {entry.kind === 'message' ? (
            <Markdown
              text={entry.text}
              block={({ index, offset: local, quote, children }) => {
                const messageId = entry.messageId ?? entry.id
                const offset = (entry.part ?? 0) + local
                const key = blockKey({ messageId, offset })
                const selected = selection?.messageId === messageId && selection.offset === offset
                const whole: Quote = { messageId, block: index, offset, quote }
                const own = comments.filter(c => c.messageId === messageId && c.offset === offset)

                return (
                  <div
                    className="message-block"
                    data-message-block={key}
                    data-message-id={messageId}
                    data-block-index={index}
                    data-block-offset={offset}
                    data-quote={quote}
                    data-active={active === key}
                    tabIndex={-1}
                    role="group"
                    aria-label={`Message block ${index + 1}`}
                    onFocus={e => {
                      if (e.target === e.currentTarget) {
                        setActive(key)
                      }
                    }}
                  >
                    {children}
                    <Button
                      className={`block-comment-action ${selected ? 'has-selection' : ''}`}
                      aria-label="Comment on this block"
                      title={selected ? 'Type to comment on your selection' : `Comment · ${label('thread.comment')}`}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => addComment({ quote: selected ? selection : whole })}
                    >
                      <Icon name="typing" size={14} />
                      {(selected || active === key) && (
                        <>
                          Comment
                          {selected ? <span className="small">or start typing</span> : <kbd>{label('thread.comment')}</kbd>}
                        </>
                      )}
                    </Button>
                    {own.map(comment => (
                      <InlineComment
                        key={comment.id}
                        comment={comment}
                        editing={editing === comment.id}
                        edit={() => setEditing(comment.id)}
                        change={text => setComments(comments.map(c =>
                          c.id === comment.id ? { ...c, text } : c))}
                        finish={() => finish({ comment })}
                        remove={() => {
                          setComments(comments.filter(c => c.id !== comment.id))
                          focusBlock({ element: blockFor({ key }) })
                        }}
                      />
                    ))}
                  </div>
                )
              }}
            />
          ) : <pre className="trace-text">{entry.text}</pre>}
          {entry.receipt && <span className={`receipt receipt-${entry.receipt}`}>{receiptLabel(entry.receipt)}</span>}
        </article>
      ))}
    </div>
  )
}

function InlineComment({ comment, editing, edit, change, finish, remove }: {
  comment: ChatComment
  editing: boolean
  edit(): void
  change(text: string): void
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
          onChange={e => change(e.target.value)}
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
