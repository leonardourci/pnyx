import type { ChatComment } from './chat.ts'
import { Button, Textarea } from '../components/ui/controls.tsx'

export function MessageComment({ comment, editing, edit, change, finish, remove }: {
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
