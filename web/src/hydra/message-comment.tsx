import { Button } from '#web-shared/ui/controls.tsx'
import { ComposerField } from '#web-shared/ui/composer-field.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { markdownText } from './markdown.tsx'
import { onNoteEdgeLine, type CaretDirection } from './caret.ts'
import { commentContext, quoteSnippet, type ChatComment } from './chat.ts'
import { COMMENT_FOCUS } from './comment-motion.ts'
import { CommentNumber } from './comment-number.tsx'

const CLIP = 40
const LINE_KEYS: Record<string, CaretDirection> = {
  ArrowUp: 'backward',
  ArrowDown: 'forward',
}

function CommentQuote({
  comment,
  clip,
  show,
}: {
  comment: ChatComment
  clip: boolean
  show?(): void
}) {
  const {
    before,
    match,
    after,
  } = quoteSnippet({
    quote: comment.quote,
    start: comment.start,
    context: markdownText({ text: commentContext({ comment }) ?? '' }),
  })

  // The whole context shows above the card, so the card itself never changes size.
  return (
    <Tooltip content={<>{before}<mark>{match}</mark>{after}</>}>
      <div
        className="comment-quote"
        role={show ? 'button' : undefined}
        tabIndex={show ? 0 : undefined}
        // The quote goes back to its passage instead of the card's own click, which focuses the note.
        onClick={event => {
          if (show) {
            event.stopPropagation(); show()
          }
        }}
        onKeyDown={event => {
          if (show && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); event.stopPropagation(); show()
          }
        }}
      >
        {clip && before.length > CLIP ? `…${before.slice(-CLIP)}` : before}
        <mark>{match}</mark>
        {after}
      </div>
    </Tooltip>
  )
}

export function MessageComment({
  comment,
  number,
  change,
  remove,
  inline = false,
  leave,
  release,
  show,
}: {
  comment: ChatComment
  number: number
  change({ text }: { text: string }): void
  remove(): void
  inline?: boolean
  leave?({
    note,
    direction,
  }: {
    note: HTMLTextAreaElement
    direction: CaretDirection | 'escape'
  }): void
  release?(): void
  show?(): void
}) {
  return (
    <div
      className="comment-card"
      data-comment-id={inline ? comment.id : undefined}
      data-comment-number={number}
      data-comment-ref={comment.id}
      onClick={() => document.dispatchEvent(new CustomEvent(
        COMMENT_FOCUS,
        { detail: comment.id },
      ))}
      contentEditable={false}
      role="group"
      aria-label={`Comment ${number}`}
    >
      <div className="comment-heading">
        <CommentNumber number={number} />
        <CommentQuote comment={comment} clip={inline} show={show} />
      </div>
      <div className="comment-row">
        <ComposerField
          className="comment-note"
          placeholder="Comment…"
          label="Comment on selected text"
          value={comment.text}
          change={change}
          // Switching apps, say to grab a screenshot, blurs the note too; keep it for the return.
          onBlur={() => {
            if (document.hasFocus()) {
              release?.()
            }
          }}
          onKeyDown={({ event }) => {
            const note = event.currentTarget, {
              key,
              shiftKey,
              altKey,
              ctrlKey,
              metaKey,
            } = event

            const modified = shiftKey || altKey || ctrlKey || metaKey

            if (!leave || event.nativeEvent.isComposing || modified) {
              return
            }

            const direction = LINE_KEYS[key]
            const edge = direction && note.selectionStart === note.selectionEnd && onNoteEdgeLine({
              note,
              direction,
            })

            if (key === 'Escape' || edge) {
              event.preventDefault(); event.stopPropagation()
              leave({
                note,
                direction: direction ?? 'escape',
              })
            }
          }}
        />
        {show && !inline && (
          <Button
            className="icon-button"
            aria-label="Show in chat"
            title="Show in chat"
            onClick={show}
          >
            <Icon name="external" size={14} />
          </Button>
        )}
        <Button className="icon-button" aria-label="Remove comment" onClick={remove}>
          <Icon name="close" size={14} />
        </Button>
      </div>
    </div>
  )
}
