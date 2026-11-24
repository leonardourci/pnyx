import { COMMENT_BADGE_SIZE } from './comment-piles.ts'

export function CommentNumber({ number }: { number: number }) {
  return (
    <span
      className="comment-number inline-flex flex-none items-center justify-center py-0 px-1 border border-gold-line rounded-full bg-gold-fill text-gold-ink text-meta leading-none tabular-nums"
      style={{
        minWidth: COMMENT_BADGE_SIZE,
        height: COMMENT_BADGE_SIZE,
      }}
      aria-hidden="true"
    >
      {number}
    </span>
  )
}
