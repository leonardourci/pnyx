// Read-only editing support keeps native caret navigation from changing recorded messages.
export const CARET_SUPPORTED = CSS.supports(
  '-webkit-user-modify',
  'read-only',
)
export const CARET_HOST = 'data-caret-host'
export const CARET_KEY = /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/
const MESSAGE_CONTROLS = '.block-comment-action, .inline-comment, .receipt, .code-language, .trace summary'
const NON_MESSAGE_TEXT = `${MESSAGE_CONTROLS}, .trace, a[href], .task-mention`
export const CARET_CSS = `[${CARET_HOST}] :is(${NON_MESSAGE_TEXT}) { -webkit-user-modify: read-only; } [${CARET_HOST}] :is(${MESSAGE_CONTROLS}) { user-select: none; }`

const selectableMessageText = ({ node }: { node: Text }) =>
  !!node.data.trim() && !node.parentElement?.closest(NON_MESSAGE_TEXT)

function* messageText({
  root,
  after,
}: {
  root: Element
  after?: Node
}) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  )

  if (after) {
    walker.currentNode = after
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && selectableMessageText({ node })) {
      yield node
    }
  }
}

export const conversationMessages = ({ from }: { from: Element }) => from
  .closest('.detail, .hydra-chat')?.querySelector<HTMLElement>(`[${CARET_HOST}]`) ?? null

export const latestAgentMessage = ({ host }: { host: HTMLElement }) =>
  [...host.querySelectorAll('.message:not(.mine, .tool, .thinking)')].at(-1) ?? null

export function caretBounds(): DOMRect | null {
  const selection = window.getSelection()

  if (!selection?.focusNode) {
    return null
  }

  const node = selection.focusNode
  const offset = selection.focusOffset
  const range = document.createRange()
  const host = (node instanceof Element ? node : node.parentElement)?.closest(`[${CARET_HOST}]`)
  let next: Text | null = null

  if (node instanceof Text && offset < node.length) {
    next = node
  } else if (host && node instanceof Text) {
    next = messageText({
      root: host,
      after: node,
    }).next().value ?? null
  }

  // The next character reports the new line when the caret sits at a soft wrap.
  if (next) {
    const start = next === node ? offset : 0
    range.setStart(
      next,
      start,
    ); range.setEnd(
      next,
      start + 1,
    )
  } else if (node instanceof Text && offset > 0) {
    range.setStart(
      node,
      offset - 1,
    ); range.setEnd(
      node,
      offset,
    )
  } else {
    range.setStart(
      node,
      offset,
    )
  }

  const rects = range.getClientRects()
  const bounds = next ? rects[0] : rects[rects.length - 1]

  return bounds?.height ? bounds : null
}

export function revealCaret({ host }: { host: HTMLElement }) {
  const scroller = host.closest('.thread')
  const caret = caretBounds()

  if (!scroller || !caret) {
    return
  }

  const viewport = scroller.getBoundingClientRect()
  const padding = Math.min(
    3 * caret.height,
    viewport.height / 3,
  )
  const above = caret.top - viewport.top - padding
  const below = caret.bottom - viewport.bottom + padding
  scroller.scrollBy({
    top: above < 0 ? above : Math.max(
      0,
      below,
    ),
  })
}

export function placeMessageCaret({
  host,
  target,
  edge,
}: {
  host: HTMLElement
  target: Element | null
  edge: 'start' | 'end'
}) {
  if (!target || !CARET_SUPPORTED) {
    return false
  }

  let node: Text | undefined

  for (const text of messageText({ root: target })) {
    node = text

    if (edge === 'start') {
      break
    }
  }

  if (!node) {
    return false
  }

  host.focus({ preventScroll: true })
  window.getSelection()?.collapse(
    node,
    edge === 'start' ? 0 : node.length,
  )
  revealCaret({ host })

  return true
}

export function focusComposer({ host }: { host: HTMLElement }) {
  const input = host.closest('.detail, .hydra-chat')?.querySelector<HTMLTextAreaElement>('.composer textarea')
  input?.focus(); input?.setSelectionRange(
    input.value.length,
    input.value.length,
  )

  return !!input
}
