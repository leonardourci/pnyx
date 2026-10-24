import { COMMENT_REVEAL, scrollMessage } from './comment-motion.ts'

// Read-only editing support keeps native caret navigation from changing recorded messages.
export const CARET_SUPPORTED = CSS.supports(
  '-webkit-user-modify',
  'read-only',
)
export const CARET_HOST = 'data-caret-host'
export const CARET_KEY = /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/
const MESSAGE_CONTROLS = '.comment-pill, .comment-card, .comment-annotations, .receipt, .code-language, .trace summary'
const QUESTION_CONTROLS = '.chat-decision .ask :is(button, textarea, input, summary)'
const NON_MESSAGE_TEXT = `${MESSAGE_CONTROLS}, .trace, a[href], .task-mention, ${QUESTION_CONTROLS}`
export const CARET_CSS = `[${CARET_HOST}] :is(${NON_MESSAGE_TEXT}) { -webkit-user-modify: read-only; } [${CARET_HOST}] :is(${MESSAGE_CONTROLS}) { user-select: none; }`

const selectableMessageText = ({ node }: { node: Text }) =>
  !!node.data.trim() && !!node.parentElement?.getClientRects().length
  && !node.parentElement.closest(NON_MESSAGE_TEXT)

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

type Position = {
  node: Node
  offset: number
}
export type CaretDirection = 'backward' | 'forward'
const NOTE_SELECTOR = '.comment-card textarea'

// Positive when a comes after b in the document.
const comparePositions = ({
  a,
  b,
}: {
  a: Position
  b: Position
}) => {
  const range = document.createRange()
  range.setStart(
    a.node,
    a.offset,
  )

  return -range.comparePoint(
    b.node,
    b.offset,
  )
}

const beside = ({
  element,
  direction,
}: {
  element: Element
  direction: CaretDirection
}): Position => {
  const range = document.createRange()

  if (direction === 'backward') {
    range.setStartBefore(element)
  } else {
    range.setStartAfter(element)
  }

  return {
    node: range.startContainer,
    offset: range.startOffset,
  }
}

const cardOf = ({ note }: { note: HTMLTextAreaElement }) => note.closest('.comment-card') ?? note

export const selectionFocus = (): Position | null => {
  const selection = window.getSelection()

  return selection?.focusNode ? {
    node: selection.focusNode,
    offset: selection.focusOffset,
  } : null
}

const textBesideNote = ({
  host,
  note,
  direction,
}: {
  host: HTMLElement
  note: HTMLTextAreaElement
  direction: CaretDirection
}): Position | null => {
  const at = beside({
    element: note,
    direction: 'backward',
  })
  const texts = [...messageText({ root: host })]

  if (direction === 'backward') {
    const text = texts.findLast(node => comparePositions({
      a: {
        node,
        offset: node.length,
      },
      b: at,
    }) < 0)

    return text ? {
      node: text,
      offset: text.length,
    } : null
  }

  const text = texts.find(node => comparePositions({
    a: {
      node,
      offset: 0,
    },
    b: at,
  }) > 0)

  return text ? {
    node: text,
    offset: 0,
  } : null
}

export function enterNote({
  note,
  direction,
  preventScroll = false,
}: {
  note: HTMLTextAreaElement
  direction: CaretDirection
  preventScroll?: boolean
}) {
  const at = direction === 'forward' ? 0 : note.value.length
  note.focus({ preventScroll })
  note.setSelectionRange(
    at,
    at,
  )
}

const placeCaret = ({
  host,
  position,
  smooth = false,
  passage,
  finished,
}: {
  host: HTMLElement
  position: Position
  smooth?: boolean
  passage?: DOMRect
  finished?(): void
}) => {
  host.focus({ preventScroll: true })
  window.getSelection()?.collapse(
    position.node,
    position.offset,
  )
  const bounds = passage ?? caretBounds()

  if (smooth && bounds) {
    scrollMessage({
      host,
      bounds,
      finished,
    })
  } else {
    revealCaret({ host })
    finished?.()
  }
}

// Escape, or a line key past the note's edge, leaves it. Worked out before the blur, which deletes an empty card.
export function leaveNote({
  host,
  note,
  direction,
  passage,
}: {
  host: HTMLElement
  note: HTMLTextAreaElement
  direction: CaretDirection | 'escape'
  passage?: DOMRect
}) {
  if (direction === 'escape') {
    const id = cardOf({ note }).getAttribute('data-comment-id')
    placeCaret({
      smooth: true,
      passage,
      finished: () => id && host.dispatchEvent(new CustomEvent(
        COMMENT_REVEAL,
        { detail: id },
      )),
      host,
      position: textBesideNote({
        host,
        note,
        direction: 'backward',
      }) ?? beside({
        element: cardOf({ note }),
        direction: 'backward',
      }),
    })

    return
  }

  const text = textBesideNote({
    host,
    note,
    direction,
  })
  const next = controlBetween({
    host,
    from: beside({
      element: cardOf({ note }),
      direction,
    }),
    to: text,
    direction,
  })

  if (next) {
    enterControl({
      control: next,
      direction,
    })
  } else if (text) {
    placeCaret({
      host,
      position: text,
    })
  } else if (direction === 'forward') {
    focusComposer({ host })
  }
}

const NOTE_TEXT_STYLES = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'overflowWrap',
  'paddingLeft',
  'paddingRight',
  'borderLeftWidth',
  'borderRightWidth',
  'tabSize',
  'whiteSpace',
  'wordBreak',
] as const

// The top of the line the caret stands on at offset, measured on a hidden copy of the note's text box.
const noteLineTop = ({
  note,
  offset,
}: {
  note: HTMLTextAreaElement
  offset: number
}) => {
  const style = getComputedStyle(note)
  const copy = document.createElement('div')

  for (const name of NOTE_TEXT_STYLES) {
    copy.style[name] = style[name]
  }

  copy.style.position = 'absolute'
  copy.style.visibility = 'hidden'
  copy.style.width = `${note.offsetWidth}px`
  const marker = document.createElement('span')
  // The caret stands on the line of the character after it; past a trailing break, on a line of its own.
  marker.textContent = note.value.slice(
    offset,
    offset + 1,
  ) || '\u200b'
  copy.append(
    note.value.slice(
      0,
      offset,
    ),
    marker,
    note.value.slice(offset + 1),
  )
  document.body.append(copy)
  const top = marker.offsetTop
  copy.remove()

  return top
}

export const onNoteEdgeLine = ({
  note,
  direction,
}: {
  note: HTMLTextAreaElement
  direction: CaretDirection
}) => noteLineTop({
  note,
  offset: note.selectionStart,
}) === noteLineTop({
  note,
  offset: direction === 'backward' ? 0 : note.value.length,
})

export function controlBetween({
  host,
  from,
  to,
  direction,
  exclude,
}: {
  host: HTMLElement
  from: Position
  to: Position | null
  direction: CaretDirection
  exclude?: HTMLElement
}): HTMLElement | undefined {
  const controls = [...host.querySelectorAll<HTMLElement>(`${QUESTION_CONTROLS}, ${NOTE_SELECTOR}`)]
    .filter(element => element !== exclude && !element.matches(':disabled') && element.getClientRects().length > 0)
  const forward = direction === 'forward'
  const matches = controls.filter(element => {
    const at = beside({
      element,
      direction: 'backward',
    })
    const past = comparePositions({
      a: at,
      b: from,
    })
    const short = !to || comparePositions({
      a: at,
      b: to,
    }) * (forward ? -1 : 1) > 0

    return (forward ? past >= 0 : past <= 0) && short
  })

  return forward ? matches[0] : matches.at(-1)
}

export function leaveQuestionControl({
  host,
  control,
  direction,
}: {
  host: HTMLElement
  control: HTMLElement
  direction: CaretDirection
}) {
  const from = beside({
    element: control,
    direction,
  })
  const texts = [...messageText({ root: host })]
  const text = direction === 'forward'
    ? texts.find(node => comparePositions({
      a: {
        node,
        offset: 0,
      },
      b: from,
    }) > 0)
    : texts.findLast(node => comparePositions({
      a: {
        node,
        offset: node.length,
      },
      b: from,
    }) < 0)
  const to = text ? {
    node: text,
    offset: direction === 'forward' ? 0 : text.length,
  } : null
  const next = controlBetween({
    host,
    from,
    to,
    direction,
    exclude: control,
  })

  if (next) {
    enterControl({
      control: next,
      direction,
    })
  } else if (to) {
    placeCaret({
      host,
      position: to,
    })
  } else if (direction === 'forward') {
    focusComposer({ host })
  }
}

export function enterControl({
  control,
  direction,
}: {
  control: HTMLElement
  direction: CaretDirection
}) {
  if (control instanceof HTMLTextAreaElement) {
    enterNote({
      note: control,
      direction,
    })
  } else {
    control.focus()
  }
}
