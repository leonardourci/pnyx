import { useState } from 'react'
import { Button } from '../components/ui/controls.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { type ChatComment } from './chat.ts'
import { MessageComment } from './message-comment.tsx'

// Its ✕ removes every comment; with more than one it asks first, until it loses focus.
export function CommentsPill({
  count,
  open,
  remove,
}: {
  count: number
  open(): void
  remove(): void
}) {
  const [
    armed,
    setArmed,
  ] = useState(false)

  return (
    <div className="composer-comments">
      <Button aria-label="Show comments" onClick={open}>
        <Icon name="comments" size={14} />
        Comments · {count}
      </Button>
      <Button
        className={armed ? 'remove-all' : 'icon-button'}
        aria-label={armed ? `Remove all ${count} comments` : 'Remove all comments'}
        onBlur={() => setArmed(false)}
        onClick={() => count > 1 && !armed ? setArmed(true) : remove()}
      >
        {armed ? `Remove ${count}?` : <Icon name="close" size={14} />}
      </Button>
    </div>
  )
}

const replyLabel = ({ at }: { at?: string }) => at
  ? `On the reply from ${new Date(at).toLocaleString(
    [],
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  )}`
  : 'On an earlier reply'

// The comments going with the next message, grouped and ordered as the agent will number them.
export function CommentsDialog({
  comments,
  shown,
  setComments,
  attach,
  show,
  close,
}: {
  comments: ChatComment[]
  shown: string[]
  setComments({ items }: { items: ChatComment[] }): void
  attach({
    id,
    files,
  }: {
    id: string
    files: File[]
  }): void
  show({ id }: { id: string }): void
  close(): void
}) {
  // A note cleared while editing stays listed until the dialog closes.
  const listed = comments.filter(comment => shown.includes(comment.id))
  const replies = new Map<string, ChatComment[]>()

  for (const comment of listed) {
    const reply = comment.at ?? comment.messageId
    replies.set(
      reply,
      [
        ...replies.get(reply) ?? [],
        comment,
      ],
    )
  }

  return (
    <Dialog title={`Comments · ${listed.length}`} className="comments-dialog" close={close}>
      <div className="dialog-body">
        {[...replies.values()].map(items => (
          <section key={items[0]!.id} className="comment-group">
            <span className="eyebrow">{replyLabel(items[0]!)}</span>
            {items.map(comment => (
              <MessageComment
                key={comment.id}
                comment={comment}
                change={({ text }) => setComments({
                  items: comments.map(c => c.id === comment.id ? {
                    ...c,
                    text,
                  } : c),
                })}
                remove={() => setComments({ items: comments.filter(c => c.id !== comment.id) })}
                attach={({ files }) => attach({
                  id: comment.id,
                  files,
                })}
                show={() => show({ id: comment.id })}
              />
            ))}
          </section>
        ))}
      </div>
      <footer className="dialog-foot">
        <span className="small muted">Numbered in this order under each reply.</span>
        <Button variant="primary" onClick={close}>Done</Button>
      </footer>
    </Dialog>
  )
}
