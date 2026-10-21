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

const textBefore = ({
  block,
  node,
  offset,
}: {
  block: HTMLElement
  node: Node
  offset: number
}) => {
  const before = document.createRange()
  before.selectNodeContents(block)
  before.setEnd(
    node,
    offset,
  )
  const fragment = before.cloneContents()
  fragment.querySelectorAll(MESSAGE_DECORATIONS).forEach(element => element.remove())

  return fragment.textContent?.length ?? 0
}

export function selectedPassage({ messages }: {
  messages: HTMLElement | null
}): CommentPassage | null {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const block = messageBlock({ node: range?.startContainer })
  const endBlock = messageBlock({ node: range?.endContainer })

  if (!messages || !range || !block || !endBlock || !messages.contains(block)
    || !messages.contains(endBlock) || block.dataset.messageId !== endBlock.dataset.messageId
    || document.activeElement?.closest('.comment-card')) {
    return null
  }

  const fragment = range.cloneContents()
  fragment.querySelectorAll(MESSAGE_DECORATIONS).forEach(element => element.remove())
  fragment.querySelectorAll('[data-message-block]').forEach(element => element.prepend('\n\n'))
  fragment.querySelectorAll('br').forEach(element => element.replaceWith('\n'))
  const quote = fragment.textContent?.trim()

  if (!quote) {
    return null
  }

  return {
    ...blockPassage({ block }),
    quote,
    paragraph: block === endBlock ? block.dataset.quote
      : [...messages.querySelectorAll<HTMLElement>('[data-message-block]')]
        .filter(candidate => candidate.dataset.messageId === block.dataset.messageId
        && range.intersectsNode(candidate))
        .map(candidate => candidate.dataset.quote)
        .join('\n\n'),
    start: textBefore({
      block,
      node: range.startContainer,
      offset: range.startOffset,
    }),
    end: {
      offset: Number(endBlock.dataset.blockOffset),
      position: textBefore({
        block: endBlock,
        node: range.endContainer,
        offset: range.endOffset,
      }),
    },
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
