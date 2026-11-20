import type { ChatComment } from './chat.ts'

export type CommentPassage = Omit<ChatComment, 'id' | 'text'>
export const MESSAGE_DECORATIONS = '.comment-card, .comment-pill, .comment-annotations, .code-language'
// Each chip in a rendered message, and each image under its text, keeps the Markdown it came from, so a copy can
// bring the chip back.
export const CHIP_SOURCE = 'data-chip-source'

const messageBlockPrefix = ({ messageId }: { messageId: string }) => `${messageId}/block-`

export const messageBlockKey = ({
  messageId,
  offset,
}: {
  messageId: string
  offset: number
}) =>
  `${messageBlockPrefix({ messageId })}${offset}`

export const isMessageBlockKey = ({
  key,
  messageId,
}: {
  key: string | null | undefined
  messageId: string
}) => key?.startsWith(messageBlockPrefix({ messageId })) === true

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
  reference: block.dataset.messageReference,
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
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null

  if (!messages || !range || !messages.contains(range.commonAncestorContainer)
    || document.activeElement?.closest('.comment-card')) {
    return null
  }

  let block = messageBlock({ node: range.startContainer })
  let endBlock = messageBlock({ node: range.endContainer })

  if (!block || !endBlock) {
    const selected = [...messages.querySelectorAll<HTMLElement>('[data-message-block]')]
      .filter(element => range.intersectsNode(element))
    block = block ?? selected[0] ?? null
    endBlock = endBlock ?? selected.at(-1) ?? null
  }

  if (!block || !endBlock || !messages.contains(block) || !messages.contains(endBlock)
    || block.dataset.messageId !== endBlock.dataset.messageId) {
    return null
  }

  if (!block.contains(range.startContainer)) {
    range.setStart(
      block,
      0,
    )
  }

  if (!endBlock.contains(range.endContainer)) {
    range.setEnd(
      endBlock,
      endBlock.childNodes.length,
    )
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
