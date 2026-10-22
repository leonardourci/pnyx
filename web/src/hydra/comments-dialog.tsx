import { useState } from 'react'
import { Button } from '../components/ui/controls.tsx'
import { Dialog } from '../components/ui/dialog.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { groupComments, orderedComments, sendableComment, type ChatComment } from './chat.ts'
import { MessageComment } from './message-comment.tsx'
import { AttachmentCard } from '../components/ui/attachment-card.tsx'

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
    <div className="composer-comments" data-armed={armed || undefined}>
      <AttachmentCard
        tone="comments"
        slot={<Icon name="comments" size={13} />}
        label={`Comments · ${count}`}
        title="Show comments"
        open={open}
        remove={() => count > 1 && !armed ? setArmed(true) : remove()}
        removeLabel={armed ? `Remove all ${count} comments` : 'Remove all comments'}
        removeText={armed ? `Remove ${count}?` : undefined}
        leaveRemove={() => setArmed(false)}
      />
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
  const numbers = new Map(orderedComments({ comments }).map((
    comment,
    index,
  ) => [
    comment.id,
    index + 1,
  ]))

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
                number={numbers.get(comment.id)!}
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
        <span className="small muted">Numbered in reading order through the replies.</span>
        <Button variant="primary" onClick={finish}>Done</Button>
      </footer>
    </Dialog>
  )
}
