import { useState } from 'react'
import { Button } from '../components/ui/controls.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { groupComments, sendableComment, type ChatComment } from './chat.ts'
import { MessageComment } from './message-comment.tsx'

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

export function CommentsDialog({
  comments,
  shown,
  setComments,
  show,
  close,
}: {
  comments: ChatComment[]
  shown: string[]
  setComments({ items }: { items: ChatComment[] }): void
  show({ id }: { id: string }): void
  close(): void
}) {
  const listed = comments.filter(comment => shown.includes(comment.id))
  const replies = groupComments({ comments: listed })

  const finish = () => {
    setComments({
      items: comments.filter(comment => !shown.includes(comment.id)
        || sendableComment({ comment })),
    })
    close()
  }

  return (
    <Dialog title={`Comments · ${listed.length}`} className="comments-dialog" close={finish}>
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
                release={() => {
                  if (!sendableComment({ comment })) {
                    setComments({ items: comments.filter(c => c.id !== comment.id) })
                  }
                }}
                show={() => show({ id: comment.id })}
              />
            ))}
          </section>
        ))}
      </div>
      <footer className="dialog-foot">
        <span className="small muted">Numbered in this order under each reply.</span>
        <Button variant="primary" onClick={finish}>Done</Button>
      </footer>
    </Dialog>
  )
}
