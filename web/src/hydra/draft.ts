// The draft stays the Markdown Hydra receives; the textarea shows each chip as its label.
export type ChipKind = 'task' | 'project' | 'image' | 'file'

export interface DraftChip {
  kind: ChipKind
  // An attachment carries the image or file itself; a reference only points at something.
  attached: boolean
  value: string
  label: string
  start: number
  end: number
}

export interface PlacedChip extends DraftChip {
  from: number
  to: number
}

export interface DraftView {
  text: string
  display: string
  chips: PlacedChip[]
}

const REFERENCE = /\[@((?:\\.|[^\]\\\r\n])*)\]\(pnyx-(task|project|image|file):([\w%~.-]+)\)/g
const IMAGE = /^\[image: (\/[^\]\n]+)\]$/gm
const FILE = /^File: ([^\n]+)\n\n(`{3,})\n[\s\S]*?\n\2$/gm

const decode = ({ value }: { value: string }) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// A fence longer than any backtick run inside keeps the file one block.
export function fileBlock({
  name,
  text,
}: {
  name: string
  text: string
}) {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map(match => match[0].length),
  )
  const fence = '`'.repeat(longest + 1)

  return `File: ${name}\n\n${fence}\n${text.replace(
    /\n$/,
    '',
  )}\n${fence}`
}

export function draftChips({ text }: { text: string }): DraftChip[] {
  const chips: DraftChip[] = []
  let images = 0

  for (const match of text.matchAll(FILE)) {
    chips.push({
      kind: 'file',
      attached: true,
      value: match[1]!,
      label: match[1]!,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  const inside = ({ at }: { at: number }) => chips.some(chip => chip.start <= at && at < chip.end)

  for (const match of text.matchAll(IMAGE)) {
    if (!inside({ at: match.index })) {
      chips.push({
        kind: 'image',
        attached: true,
        value: match[1]!,
        label: `Image ${++images}`,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  for (const match of text.matchAll(REFERENCE)) {
    if (!inside({ at: match.index })) {
      chips.push({
        kind: match[2] as ChipKind,
        attached: false,
        value: decode({ value: match[3]! }),
        label: `@${match[1]!.replace(
          /\\(.)/g,
          '$1',
        )}`,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return chips.sort((
    a,
    b,
  ) => a.start - b.start)
}

export function draftView({ text }: { text: string }): DraftView {
  let display = '', cursor = 0
  const chips = draftChips({ text }).map(chip => {
    display += text.slice(
      cursor,
      chip.start,
    )
    const from = display.length
    display += chip.label
    cursor = chip.end

    return {
      ...chip,
      from,
      to: display.length,
    }
  })

  return {
    text,
    display: display + text.slice(cursor),
    chips,
  }
}

// A display offset inside a chip maps to the chip's end.
export function sourceOffset({
  view,
  offset,
}: {
  view: DraftView
  offset: number
}) {
  let shift = 0

  for (const chip of view.chips) {
    if (offset < chip.to) {
      return offset <= chip.from ? offset + shift : chip.end
    }

    shift += chip.end - chip.start - (chip.to - chip.from)
  }

  return offset + shift
}

export function displayOffset({
  view,
  offset,
}: {
  view: DraftView
  offset: number
}) {
  let shift = 0

  for (const chip of view.chips) {
    if (offset < chip.end) {
      return offset <= chip.start ? offset - shift : chip.to
    }

    shift += chip.end - chip.start - (chip.to - chip.from)
  }

  return offset - shift
}

// A caret never rests inside a chip: it moves to the edge it was heading for.
export function snapCaret({
  view,
  offset,
  backward,
}: {
  view: DraftView
  offset: number
  backward: boolean
}) {
  const chip = view.chips.find(c => c.from < offset && offset < c.to)

  return chip ? backward ? chip.from : chip.to : offset
}

// A chip the range touches goes as a whole, so its Markdown is never left half edited.
export function replaceDisplay({
  text,
  from,
  to,
  insert,
}: {
  text: string
  from: number
  to: number
  insert: string
}): {
  text: string
  caret: number
} {
  const view = draftView({ text })
  let start = from, end = to

  for (const chip of view.chips) {
    if (start < end ? start < chip.to && end > chip.from : chip.from < start && start < chip.to) {
      start = Math.min(
        start,
        chip.from,
      )
      end = Math.max(
        end,
        chip.to,
      )
    }
  }

  const head = sourceOffset({
    view,
    offset: start,
  })
  const next = text.slice(
    0,
    head,
  ) + insert + text.slice(sourceOffset({
    view,
    offset: end,
  }))

  return {
    text: next,
    caret: displayOffset({
      view: draftView({ text: next }),
      offset: head + insert.length,
    }),
  }
}

// The caret places the edit when the same character repeats around it.
export function editDraft({
  text,
  next,
  caret,
}: {
  text: string
  next: string
  caret: number
}) {
  const before = draftView({ text }).display
  let prefix = 0, suffix = 0

  while (prefix < caret && prefix < before.length && before[prefix] === next[prefix]) {
    prefix++
  }

  while (suffix < next.length - caret && suffix < before.length - prefix
    && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix++
  }

  return replaceDisplay({
    text,
    from: prefix,
    to: before.length - suffix,
    insert: next.slice(
      prefix,
      next.length - suffix,
    ),
  })
}
