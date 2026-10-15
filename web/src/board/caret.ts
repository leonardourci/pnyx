// Messages are contenteditable only so the browser draws a caret; Chromium-only (-webkit-user-modify).
export const CARET_HOST = 'data-caret-host'
export const CARET_KEY = /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/
const ISLANDS = '.block-comment-action, .inline-comment, .trace, .receipt, .code-language'
// Lines kept in view above and below the caret as it moves.
const MARGIN_LINES = 3

const texts = ({ root }: { root: Element }) => {
  const found: Text[] = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() && !node.parentElement?.closest(ISLANDS)) {
      found.push(node as Text)
    }
  }

  return found
}

export const hostOf = ({ from }: { from: Element }) => from.closest('.thread')?.querySelector<HTMLElement>(`[${CARET_HOST}]`) ?? null

export const latestReply = ({ host }: { host: HTMLElement }) => [...host.querySelectorAll('.message.message:not(.mine)')].at(-1) ?? null

// Measured on the next character: at a soft wrap the caret ends the prior text but draws on the next line.
export function caretBox(): DOMRect | null {
  const selection = window.getSelection(), node = selection?.focusNode

  if (!selection || !node) {
    return null
  }

  const offset = selection.focusOffset, range = document.createRange()
  const host = (node instanceof Element ? node : node.parentElement)?.closest(`[${CARET_HOST}]`)
  const all = host && node instanceof Text ? texts({ root: host }) : []
  const index = all.indexOf(node as Text), following = index < 0 ? undefined : all[index + 1]
  const next = node instanceof Text && offset < node.length ? { text: node, at: offset }
    : following ? { text: following, at: 0 } : null

  if (next) {
    range.setStart(next.text, next.at); range.setEnd(next.text, next.at + 1)
  } else if (node instanceof Text && offset > 0) {
    range.setStart(node, offset - 1); range.setEnd(node, offset)
  } else {
    range.setStart(node, offset)
  }

  const rects = range.getClientRects(), rect = next ? rects[0] : rects[rects.length - 1]

  return rect?.height ? rect : null
}

export function reveal({ host }: { host: HTMLElement }) {
  const scroller = host.closest('.thread'), box = caretBox()

  if (!scroller || !box) {
    return
  }

  const view = scroller.getBoundingClientRect()
  const margin = Math.min(MARGIN_LINES * box.height, view.height / 3)
  const above = box.top - (view.top + margin), below = box.bottom - (view.bottom - margin)
  scroller.scrollBy({ top: above < 0 ? above : Math.max(0, below) })
}

// False when `target` has no text.
export function caretInto({ host, target, edge }: { host: HTMLElement; target: Element | null; edge: 'start' | 'end' }) {
  const all = target ? texts({ root: target }) : [], node = edge === 'start' ? all[0] : all.at(-1)

  if (!node) {
    return false
  }

  host.focus({ preventScroll: true }); window.getSelection()?.collapse(node, edge === 'start' ? 0 : node.length); reveal({ host })

  return true
}

export function focusReply({ host }: { host: HTMLElement }) {
  const input = host.closest('.thread')?.querySelector<HTMLTextAreaElement>('.composer textarea')
  input?.focus(); input?.setSelectionRange(input.value.length, input.value.length)

  return !!input
}
