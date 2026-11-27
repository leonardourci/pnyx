import { displayAt, draftView } from './draft.ts'

// A chip host keeps its Markdown, so one the browser puts back, as on Undo, reads as its chip again.
const chipSource = ({ node }: { node: Node }) =>
  node instanceof HTMLElement ? node.dataset.source : undefined

// A break at the very end draws no line, so it is the browser's placeholder, not a newline.
const endsField = ({
  field,
  node,
}: {
  field: HTMLElement
  node: Node
}) => {
  for (let at: Node | null = node; at && at !== field; at = at.parentNode) {
    if (at.nextSibling) {
      return false
    }
  }

  return true
}

interface Point {
  node: Node
  offset: number
}

// Each point becomes its offset into the draft's Markdown; a point outside the field stays undefined.
function measure({
  field,
  points,
}: {
  field: HTMLElement
  points: Point[]
}) {
  let source = '', endBreak = false
  const found: (number | undefined)[] = points.map(() => undefined)

  const mark = ({
    node,
    offset,
  }: {
    node: Node
    offset: number
  }) => points.forEach((
    point,
    index,
  ) => {
    if (point.node === node && point.offset === offset) {
      found[index] = source.length
    }
  })

  const visit = ({ node }: { node: Node }) => {
    if (node instanceof Text) {
      points.forEach((
        point,
        index,
      ) => {
        if (point.node === node) {
          found[index] = source.length + point.offset
        }
      })
      source += node.data

      return
    }

    const chip = chipSource({ node })

    if (chip !== undefined) {
      source += chip
      // A point inside a chip, as when its text is selected, counts as just after it.
      points.forEach((
        point,
        index,
      ) => {
        if (node.contains(point.node)) {
          found[index] = source.length
        }
      })

      return
    }

    if (node instanceof HTMLBRElement) {
      endBreak = endsField({
        field,
        node,
      })

      if (!endBreak) {
        source += '\n'
      }

      return
    }

    // A block the browser wrapped a new line in starts its own line.
    const block = node !== field && node instanceof HTMLElement && /^(DIV|P)$/.test(node.tagName)

    if (block && source && !source.endsWith('\n')) {
      source += '\n'
    }

    node.childNodes.forEach((
      child,
      index,
    ) => {
      mark({
        node,
        offset: index,
      })
      visit({ node: child })
    })
    mark({
      node,
      offset: node.childNodes.length,
    })
  }

  visit({ node: field })

  // A trailing newline draws no line, so the browser ends such text with one more newline.
  if (!endBreak && source.endsWith('\n')) {
    source = source.slice(
      0,
      -1,
    )
  }

  return {
    text: source,
    found: found.map(at => at === undefined ? undefined : Math.min(
      at,
      source.length,
    )),
  }
}

// The field's draft, and its selection as display offsets when the selection is inside it.
export function readField({ field }: { field: HTMLElement }) {
  const selection = getSelection()
  const inside = !!selection?.anchorNode && !!selection.focusNode
    && field.contains(selection.anchorNode) && field.contains(selection.focusNode)
  const {
    text,
    found: [
      anchor,
      focus,
    ],
  } = measure({
    field,
    points: inside ? [
      {
        node: selection.anchorNode!,
        offset: selection.anchorOffset,
      },
      {
        node: selection.focusNode!,
        offset: selection.focusOffset,
      },
    ] : [],
  })
  const shown = ({ at }: { at?: number }) => displayAt({
    text,
    offset: at ?? text.length,
  })

  return {
    text,
    inside,
    anchor: shown({ at: anchor }),
    focus: shown({ at: focus }),
  }
}

// A blurred field keeps where its selection was, as a textarea does, so an insert after a click elsewhere lands there.
const remembered = new WeakMap<HTMLElement, {
  anchor: number
  focus: number
}>()

const liveEnds = ({ field }: { field: HTMLElement }) => {
  const read = readField({ field })

  return read.inside ? {
    anchor: read.anchor,
    focus: read.focus,
  } : undefined
}

export function selectionEnds({ field }: { field: HTMLElement }) {
  const live = liveEnds({ field })

  if (live) {
    remembered.set(
      field,
      live,
    )
  }

  return live ?? remembered.get(field) ?? {
    anchor: 0,
    focus: 0,
  }
}

export function selectionRange({ field }: { field: HTMLElement }) {
  const {
    anchor,
    focus,
  } = selectionEnds({ field })

  return {
    start: Math.min(
      anchor,
      focus,
    ),
    end: Math.max(
      anchor,
      focus,
    ),
  }
}

// A point inside text where there is text, so typing there joins it rather than starting a node.
function pointAt({
  field,
  offset,
}: {
  field: HTMLElement
  offset: number
}): Point {
  let left = offset

  for (const [
    index,
    node,
  ] of [...field.childNodes].entries()) {
    // A marked path holds its text in one child.
    const marked = node.firstChild instanceof Text && chipSource({ node }) === undefined
    const text = node instanceof Text ? node : marked ? node.firstChild as Text : undefined

    if (text) {
      if (left <= text.data.length) {
        return {
          node: text,
          offset: left,
        }
      }

      left -= text.data.length
    } else if (chipSource({ node }) !== undefined) {
      if (left === 0) {
        return {
          node: field,
          offset: index,
        }
      }

      left -= 1
    }
  }

  return {
    node: field,
    offset: field.childNodes.length,
  }
}

// Selects between display offsets; a blurred field only remembers it, so nothing steals focus.
export function select({
  field,
  anchor,
  focus,
}: {
  field: HTMLElement
  anchor: number
  focus: number
}) {
  remembered.set(
    field,
    {
      anchor,
      focus,
    },
  )
  const live = liveEnds({ field })

  if (document.activeElement !== field || (live?.anchor === anchor && live.focus === focus)) {
    return
  }

  const from = pointAt({
    field,
    offset: anchor,
  })
  const to = pointAt({
    field,
    offset: focus,
  })
  getSelection()?.setBaseAndExtent(
    from.node,
    from.offset,
    to.node,
    to.offset,
  )
}

export function focusAtEnd({
  field,
  preventScroll = false,
}: {
  field: HTMLElement
  preventScroll?: boolean
}) {
  field.focus({ preventScroll })
  const end = draftView({ text: readField({ field }).text }).display.length
  select({
    field,
    anchor: end,
    focus: end,
  })
}

// Puts back the selection the field last had, as focusing a textarea does.
export function restoreSelection({ field }: { field: HTMLElement }) {
  const ends = remembered.get(field)

  if (ends) {
    select({
      field,
      ...ends,
    })
  }
}

type Part = {
  text: string
  path: boolean
} | HTMLElement

// The browser may split text across several nodes, as Chrome does for each new line; they read as one run.
const shownRuns = ({ field }: { field: HTMLElement }) => {
  const runs: (string | ChildNode)[] = []

  for (const node of field.childNodes) {
    const previous = runs.at(-1)

    if (!(node instanceof Text)) {
      runs.push(node)
    } else if (typeof previous === 'string') {
      runs[runs.length - 1] = previous + node.data
    } else if (node.data) {
      runs.push(node.data)
    }
  }

  return runs
}

const paintedAs = ({
  run,
  part,
  last,
}: {
  run?: string | ChildNode
  part: Part
  last: boolean
}) => {
  if (part instanceof HTMLElement) {
    return run === part
  }

  if (part.path) {
    return run instanceof HTMLElement && run.dataset.composer === 'path' && run.childNodes.length === 1
      && run.textContent === part.text
  }

  // Typing after a trailing newline leaves the browser's own newline behind, which reads the same.
  return run === part.text || (last && run === `${part.text}\n`)
}

const partNode = ({ part }: { part: Part }) => {
  if (part instanceof HTMLElement) {
    return part
  }

  if (!part.path) {
    return document.createTextNode(part.text)
  }

  const marked = document.createElement('span')
  marked.dataset.composer = 'path'
  marked.className = 'draft-path rounded bg-gold-wash shadow-draft-path text-gold'
  marked.textContent = part.text

  return marked
}

// Writes the draft into the field, leaving it untouched when it already shows it, so typing keeps its Undo.
export function paintField({
  field,
  view,
  hosts,
  paths,
}: {
  field: HTMLElement
  view: ReturnType<typeof draftView>
  hosts: HTMLElement[]
  paths: {
    from: number
    to: number
  }[]
}) {
  const parts: Part[] = []

  const gap = ({
    from,
    to,
  }: {
    from: number
    to: number
  }) => {
    let at = from

    for (const path of paths.filter(path => path.to > from && path.from < to)) {
      const start = Math.max(
        path.from,
        at,
      )
      const end = Math.min(
        path.to,
        to,
      )

      if (start > at) {
        parts.push({
          text: view.display.slice(
            at,
            start,
          ),
          path: false,
        })
      }

      parts.push({
        text: view.display.slice(
          start,
          end,
        ),
        path: true,
      })
      at = end
    }

    if (to > at) {
      parts.push({
        text: view.display.slice(
          at,
          to,
        ),
        path: false,
      })
    }
  }

  view.chips.forEach((
    chip,
    index,
  ) => {
    gap({
      from: view.chips[index - 1]?.to ?? 0,
      to: chip.from,
    })
    parts.push(hosts[index]!)
  })
  gap({
    from: view.chips.at(-1)?.to ?? 0,
    to: view.display.length,
  })

  const last = parts.at(-1)

  if (view.display.endsWith('\n') && last && !(last instanceof HTMLElement)) {
    last.text += '\n'
  }

  const runs = shownRuns({ field })
  const painted = runs.length === parts.length && parts.every((
    part,
    index,
  ) => paintedAs({
    run: runs[index],
    part,
    last: index === parts.length - 1,
  }))

  field.toggleAttribute(
    'data-empty',
    view.display === '',
  )

  if (painted) {
    return
  }

  field.replaceChildren(...parts.map(part => partNode({ part })))
}
