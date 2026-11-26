import { ICON_SIZE } from '#web-shared/icons.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { useEffect,useRef } from 'react'
import type { ChatDrafts } from './chat-drafts.ts'
import { ComposerField,type ComposerFieldHandle } from './composer-field.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { markdownText } from './markdown-text.ts'
import { commentContext, quoteSnippet, type ChatComment } from './chat.ts'
import { COMMENT_FOCUS } from './comment-motion.ts'
import { draftView } from './draft.ts'
import { CommentNumber } from './comment-number.tsx'

const CLIP = 40

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
        className="comment-quote overflow-hidden text-muted text-meta leading-detail text-ellipsis whitespace-nowrap [&_mark]:py-0 [&_mark]:px-px [&_mark]:rounded-xs [&_mark]:bg-(--comment-highlight) [&_mark]:text-ink in-[.comments-dialog]:line-clamp-4 in-[.comments-dialog]:whitespace-normal"
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
  drafts,
  remove,
  inline = false,
  release,
  show,
}: {
  drafts: ChatDrafts
  comment: ChatComment
  number: number
  remove(): void
  inline?: boolean
  release?(): void
  show?(): void
}) {
  const field = useRef<ComposerFieldHandle>(null)
  const read = () => drafts.read().comments.find(item => item.id === comment.id)?.text
    ?? comment.text
  useEffect(
    () => drafts.subscribe(() => {
      const editor = field.current
      const text = read()

      if (editor && editor.read() !== text) {
        editor.write({
          text,
          caret: draftView({ text }).display.length,
        })
      }
    }),
    [
      drafts,
      comment.id,
    ],
  )

  return (
    <div
      className="comment-card [transition:var(--transition-comment-card)] relative flex flex-col gap-0.75 mt-1.5 mx-0 mb-2.5 py-1.5 pr-1.5 pl-2.5 border border-line border-l-2 border-l-gold rounded-lg bg-raised text-ui select-none data-emphasis:bg-comment-card-emphasis data-emphasis:border-gold data-emphasis:shadow-comment-emphasis focus-within:border-gold-line focus-within:border-l-gold data-jump:after:content-[''] data-jump:after:absolute data-jump:after:inset-0 data-jump:after:rounded-[inherit] data-jump:after:pointer-events-none data-jump:after:bg-(--comment-jump-highlight) data-jump:after:shadow-comment-jump data-jump:after:animate-comment-jump motion-reduce:data-jump:after:animate-none motion-reduce:data-jump:after:opacity-50 motion-reduce:transition-none in-[.comments-dialog]:my-1"
      data-comment-id={inline ? comment.id : undefined}
      data-comment-number={number}
      data-comment-ref={comment.id}
      onClick={() => document.dispatchEvent(new CustomEvent(
        COMMENT_FOCUS,
        { detail: comment.id },
      ))}
      role="group"
      aria-label={`Comment ${number}`}
    >
      <div className="comment-heading flex items-start gap-1.5 min-w-0 [&_.comment-quote]:flex-1 [&_.comment-quote]:min-w-0 [&>.tooltip-anchor]:flex [&>.tooltip-anchor]:flex-1 [&>.tooltip-anchor]:min-w-0">
        <CommentNumber number={number} />
        <CommentQuote comment={comment} clip={inline} show={show} />
      </div>
      <div className="comment-row flex items-start gap-1.5">
        <ComposerField
          ref={field}
          className="comment-note"
          placeholder="Comment…"
          label="Comment on selected text"
          value={read()}
          change={({ text }) => drafts.editComment({
            id: comment.id,
            text,
          })}
          // Switching apps, say to grab a screenshot, blurs the note too; keep it for the return.
          onBlur={() => {
            if (document.hasFocus()) {
              release?.()
            }
          }}
        />
        {show && !inline && (
          <IconButton
            size="small"
            icon="external"
            iconSize={ICON_SIZE.inline}
            label="Show in chat"
            title="Show in chat"
            onClick={show}
          />
        )}
        <IconButton
          size="small"
          icon="close"
          iconSize={ICON_SIZE.inline}
          label="Remove comment"
          onClick={remove}
        />
      </div>
    </div>
  )
}
