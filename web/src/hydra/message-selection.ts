import type { ChatComment } from './chat.ts'

export type CommentPassage = Omit<ChatComment, 'id' | 'text'>
export const MESSAGE_DECORATIONS = '.comment-card, .comment-pill, .comment-annotations, .code-language, .receipt'

export const messageBlockKey = ({
  messageId,
  offset,
}: {
  messageId: string
  offset: number
}) =>
  `${messageId}/block-${offset}`

export const messageBlock = ({ node }: { node?: Node | null }) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-message-block]')

export const blockPassage = ({ block }: { block: HTMLElement }): CommentPassage => ({
  messageId: block.dataset.messageId!,
  block: Number(block.dataset.blockIndex),
  offset: Number(block.dataset.blockOffset),
  start: 0,
  quote: block.dataset.quote!,
  paragraph: block.dataset.quote!,
  at: block.dataset.messageAt,
})

export function selectedPassage({ messages }: {
  messages: HTMLElement | null
}): CommentPassage | null {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const quote = selection?.toString().trim()
  const block = messageBlock({ node: range?.startContainer })

  if (!messages || !range || !quote || !block || !messages.contains(range.endContainer)
    || document.activeElement?.closest('.comment-card')) {
    return null
  }

  const before = range.cloneRange()
  before.selectNodeContents(block)
  before.setEnd(
    range.startContainer,
    range.startOffset,
  )
  const fragment = before.cloneContents()
  fragment.querySelectorAll(MESSAGE_DECORATIONS).forEach(element => element.remove())

  return {
    ...blockPassage({ block }),
    quote,
    start: fragment.textContent?.length ?? 0,
  }
}

export const samePassage = ({
  before,
  after,
}: {
  before: CommentPassage | null
  after: CommentPassage | null
}) => before?.messageId === after?.messageId && before?.offset === after?.offset
    && before?.quote === after?.quote
    && (before?.start === undefined || after?.start === undefined || before.start === after.start)
