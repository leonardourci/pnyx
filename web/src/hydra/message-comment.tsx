import { imagePaths } from '../../../src/attachments/images.ts'
import { AttachedImage } from '../components/ui/attached-image.tsx'
import { Button, Textarea } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { onNoteEdgeLine, type CaretDirection } from './caret.ts'
import { Marked } from 'marked'
import { commentContext, quoteSnippet, type ChatComment } from './chat.ts'

const CLIP = 40
const markdown = new Marked({ gfm: true })

// The paragraph as it reads in the chat, its Markdown syntax rendered away; the agent gets the source.
const readable = ({ text }: { text: string }) => new DOMParser()
  .parseFromString(
    markdown.parseInline(text) as string,
    'text/html',
  ).body.textContent ?? text

// The context sent to the agent with the quote marked; the title holds all of it.
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
    context: readable({ text: commentContext({ comment }) ?? '' }),
  })

  return (
    <div className="comment-quote" title={before + match + after}>
      {clip && before.length > CLIP ? `…${before.slice(-CLIP)}` : before}
      <mark>{match}</mark>
      {after}
    </div>
  )
}

// A comment under its passage, or in the composer's list. Its note is always editable.
export function MessageComment({
  comment,
  change,
  remove,
  attach,
  inline = false,
  leave,
  release,
  show,
}: {
  comment: ChatComment
  change({ text }: { text: string }): void
  remove(): void
  attach({ files }: { files: File[] }): void
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
      contentEditable={false}
      role="group"
      aria-label="Comment"
    >
      <CommentQuote comment={comment} clip={inline} />
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
            const files = [...event.clipboardData.files]

            // Office apps put a picture of copied text next to the text itself.
            if (files.length && !event.clipboardData.types.includes('text/plain')) {
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

            const direction = key === 'ArrowUp' ? 'backward' : key === 'ArrowDown' ? 'forward' : null

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
