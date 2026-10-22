import { IMAGE } from '../../../src/attachments/images.ts'
import { FILE_BLOCK } from '../../../src/attachments/files.ts'
import { decodeValue, REFERENCE, referenceLabel, type ReferenceKind } from '../../../src/mentions/mentions.ts'

// The draft stays the Markdown Hydra receives; the textarea shows each chip as its label.
export type ChipKind = ReferenceKind

// An em space holds an icon's room in the textarea (a task chip has two, an image chip's thumbnail two); the chip draws over them.
export const ICON_SPACE = '\u2003'

interface DraftChip {
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

interface DraftView {
  display: string
  chips: PlacedChip[]
}

function draftChips({ text }: { text: string }): DraftChip[] {
  const chips: DraftChip[] = []
  let images = 0

  for (const match of text.matchAll(FILE_BLOCK)) {
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
        label: `${ICON_SPACE}${ICON_SPACE}Image ${++images}`,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  for (const match of text.matchAll(new RegExp(
    REFERENCE.source,
    'g',
  ))) {
    if (!inside({ at: match.index })) {
      chips.push({
        kind: match[2] as ChipKind,
        attached: false,
        value: decodeValue({ value: match[3]! }) ?? match[3]!,
        label: `${{
          column: ICON_SPACE,
          task: ICON_SPACE + ICON_SPACE,
        }[match[2]!] ?? '@'}${referenceLabel({ label: match[1]! })}`,
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
    display: display + text.slice(cursor),
    chips,
  }
}

// A display offset inside a chip maps to the chip's end.
function sourceOffset({
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

function displayOffset({
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

// The newlines that make a block its own paragraph, after the ones already there.
const paragraphBreak = ({ newlines }: { newlines: string }) => '\n'.repeat(2 - newlines.length)

// An attachment counts only as its own paragraph, so it goes after the caret's line and never splits a word.
export function placeBlock({
  text,
  caret: at,
  block,
}: {
  text: string
  caret?: number
  block: string
}) {
  const shown = draftView({ text }).display
  const caret = Math.min(
    at ?? shown.length,
    shown.length,
  )
  const lineEnd = shown.indexOf(
    '\n',
    caret,
  )
  const cursor = lineEnd < 0 ? shown.length : lineEnd
  const before = shown.slice(
      0,
      cursor,
    ), after = shown.slice(cursor)
  const lead = before.trim() ? paragraphBreak({ newlines: /\n{0,2}$/.exec(before)?.[0] ?? '' }) : ''
  const tail = paragraphBreak({ newlines: /^\n{0,2}/.exec(after)?.[0] ?? '' })
  const edit = replaceDisplay({
    text,
    from: cursor,
    to: cursor,
    insert: lead + block + tail,
  })

  return cursor === caret ? edit : {
    text: edit.text,
    caret,
  }
}

// The caret places the edit when the same character repeats around it: typed text ends at the caret.
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
  const typed = Math.max(
    0,
    next.length - before.length,
  )
  let prefix = 0, suffix = 0

  while (prefix < caret - typed && prefix < before.length && before[prefix] === next[prefix]) {
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
