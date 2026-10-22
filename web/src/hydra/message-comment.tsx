import { imagePaths } from '../../../src/attachments/images.ts'
import { AttachedImage } from '../components/ui/attached-image.tsx'
import { Button, Textarea } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { markdownText } from '../components/ui/markdown.tsx'
import { onNoteEdgeLine, type CaretDirection } from './caret.ts'
import { commentContext, quoteSnippet, type ChatComment } from './chat.ts'
import { pastedImages } from './image-upload.ts'
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
}: {
  comment: ChatComment
  clip: boolean
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
      <div className="comment-quote">
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
  attach,
  inline = false,
  leave,
  release,
  show,
}: {
  comment: ChatComment
  number: number
  change({ text }: { text: string }): void
  remove(): void
  attach?({ files }: { files: File[] }): void
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
  const images = imagePaths({ text: (comment.images ?? []).join('\n') })

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
        <CommentQuote comment={comment} clip={inline} />
      </div>
      <div className="comment-row">
        <Textarea
          className="comment-note"
          rows={1}
          placeholder="Comment…"
          aria-label="Comment on selected text"
          value={comment.text}
          onChange={e => change({ text: e.target.value })}
          // Switching apps, say to grab a screenshot, blurs the note too; keep it for the return.
          onBlur={() => {
            if (document.hasFocus()) {
              release?.()
            }
          }}
          onPaste={event => {
            const files = pastedImages({ clipboardData: event.clipboardData })

            if (attach && files.length) {
              event.preventDefault(); attach({ files })
            }
          }}
          onKeyDown={event => {
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
        {show && (
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
      {images.length > 0 && (
        <div className="comment-images">
          {images.map(path => <AttachedImage key={path} path={path} />)}
        </div>
      )}
    </div>
  )
}
