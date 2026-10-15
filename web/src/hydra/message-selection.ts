import type { ChatComment } from './chat.ts'

export type CommentPassage = Omit<ChatComment, 'id' | 'text'>

export const messageBlockKey = ({ messageId, offset }: { messageId: string; offset: number }) =>
  `${messageId}/block-${offset}`

export const messageBlock = ({ node }: { node?: Node | null }) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-message-block]')

export const blockPassage = ({ block }: { block: HTMLElement }): CommentPassage => ({
  messageId: block.dataset.messageId!,
  block: Number(block.dataset.blockIndex),
  offset: Number(block.dataset.blockOffset),
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
    || document.activeElement?.closest('.inline-comment')) {
    return null
  }

  return { ...blockPassage({ block }), quote }
}

export const samePassage = ({ before, after }: {
  before: CommentPassage | null
  after: CommentPassage | null
}) => before?.messageId === after?.messageId && before?.offset === after?.offset
  && before?.quote === after?.quote
