import { COMMENT_BADGE_SIZE } from './comment-piles.ts'

export function CommentNumber({ number }: { number: number }) {
  return (
    <span
      className="comment-number"
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
