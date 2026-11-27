import { displayAt, draftView, type PlacedChip } from './draft.ts'

const PATH_MARK = 'path'

const chipSource = ({ node }: { node: Node }) =>
  node instanceof HTMLElement ? node.dataset.source : undefined

const isPathMark = ({ node }: { node: Node }) =>
  node instanceof HTMLElement && node.dataset.composer === PATH_MARK

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

function readSource({
  field,
  points,
}: {
  field: HTMLElement
  points: Point[]
}) {
  let source = '', placeholderBreak = false
  const offsets: (number | undefined)[] = points.map(() => undefined)

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
      offsets[index] = source.length
    }
  })

  const markAfterChip = ({ chip }: { chip: Node }) => points.forEach((
    point,
    index,
  ) => {
    if (chip.contains(point.node)) {
      offsets[index] = source.length
    }
  })

  const visit = ({ node }: { node: Node }) => {
    if (node instanceof Text) {
      points.forEach((
        point,
        index,
      ) => {
        if (point.node === node) {
          offsets[index] = source.length + point.offset
        }
      })
      source += node.data

      return
    }

    const chipMarkdown = chipSource({ node })

    if (chipMarkdown !== undefined) {
      source += chipMarkdown
      markAfterChip({ chip: node })

      return
    }

    if (node instanceof HTMLBRElement) {
      placeholderBreak = endsField({
        field,
        node,
      })

      if (!placeholderBreak) {
        source += '\n'
      }

      return
    }

    const wrappedLine = node !== field && node instanceof HTMLElement && /^(DIV|P)$/.test(node.tagName)

    if (wrappedLine && source && !source.endsWith('\n')) {
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
  const extraEndNewline = !placeholderBreak && source.endsWith('\n')

  if (extraEndNewline) {
    source = source.slice(
      0,
      -1,
    )
  }

  return {
    text: source,
    offsets: offsets.map(at => at === undefined ? undefined : Math.min(
      at,
      source.length,
    )),
  }
}

function selectedPoints({ field }: { field: HTMLElement }): Point[] {
  const selection = getSelection()
  const anchor = selection?.anchorNode
  const focus = selection?.focusNode

  if (!selection || !anchor || !focus) {
    return []
  }

  if (!field.contains(anchor) || !field.contains(focus)) {
    return []
  }

  return [
    {
      node: anchor,
      offset: selection.anchorOffset,
    },
    {
      node: focus,
      offset: selection.focusOffset,
    },
  ]
}

export function readField({ field }: { field: HTMLElement }) {
  const points = selectedPoints({ field })
  const {
    text,
    offsets: [
      anchor,
      focus,
    ],
  } = readSource({
    field,
    points,
  })
  const shown = ({ at }: { at?: number }) => displayAt({
    text,
    offset: at ?? text.length,
  })

  return {
    text,
    inside: points.length > 0,
    anchor: shown({ at: anchor }),
    focus: shown({ at: focus }),
  }
}

const rememberedSelections = new WeakMap<HTMLElement, {
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
    rememberedSelections.set(
      field,
      live,
    )
  }

  return live ?? rememberedSelections.get(field) ?? {
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

const textOf = ({ node }: { node: ChildNode }) => {
  if (node instanceof Text) {
    return node
  }

  return isPathMark({ node }) && node.firstChild instanceof Text ? node.firstChild : undefined
}

function textPointAt({
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
    const text = textOf({ node })

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

export function select({
  field,
  anchor,
  focus,
}: {
  field: HTMLElement
  anchor: number
  focus: number
}) {
  rememberedSelections.set(
    field,
    {
      anchor,
      focus,
    },
  )
  const live = liveEnds({ field })
  const focused = document.activeElement === field
  const alreadySelected = live?.anchor === anchor && live.focus === focus

  if (!focused || alreadySelected) {
    return
  }

  const from = textPointAt({
    field,
    offset: anchor,
  })
  const to = textPointAt({
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

export function restoreSelection({ field }: { field: HTMLElement }) {
  const ends = rememberedSelections.get(field)

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

const joinedRuns = ({ field }: { field: HTMLElement }) => {
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
    return run instanceof HTMLElement && isPathMark({ node: run }) && run.childNodes.length === 1
      && run.textContent === part.text
  }

  const keepsBrowserEndNewline = last && run === `${part.text}\n`

  return run === part.text || keepsBrowserEndNewline
}

const partNode = ({ part }: { part: Part }) => {
  if (part instanceof HTMLElement) {
    return part
  }

  if (!part.path) {
    return document.createTextNode(part.text)
  }

  const marked = document.createElement('span')
  marked.dataset.composer = PATH_MARK
  marked.className = 'draft-path rounded bg-gold-wash shadow-draft-path text-gold'
  marked.textContent = part.text

  return marked
}

export function paintField({
  field,
  display,
  chips,
  paths,
}: {
  field: HTMLElement
  display: string
  chips: {
    chip: PlacedChip
    host: HTMLElement
  }[]
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
          text: display.slice(
            at,
            start,
          ),
          path: false,
        })
      }

      parts.push({
        text: display.slice(
          start,
          end,
        ),
        path: true,
      })
      at = end
    }

    if (to > at) {
      parts.push({
        text: display.slice(
          at,
          to,
        ),
        path: false,
      })
    }
  }

  chips.forEach((
    {
      chip,
      host,
    },
    index,
  ) => {
    gap({
      from: chips[index - 1]?.chip.to ?? 0,
      to: chip.from,
    })
    parts.push(host)
  })
  gap({
    from: chips.at(-1)?.chip.to ?? 0,
    to: display.length,
  })

  const last = parts.at(-1)

  if (display.endsWith('\n') && last && !(last instanceof HTMLElement)) {
    last.text += '\n'
  }

  const runs = joinedRuns({ field })
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
    display === '',
  )

  if (painted) {
    return
  }

  field.replaceChildren(...parts.map(part => partNode({ part })))
}
