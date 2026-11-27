import { readSkillReference } from '#titan/transcripts-skill-reference.ts'
import { IMAGE, imageNames, imagePaths } from '#titan/images.ts'
import { FILE_BLOCK } from '#titan/attachments.ts'
import { CHIP_CHARACTER, decodeValue, REFERENCE, referenceLabel, type ReferenceKind } from '#titan/mentions.ts'

export type ChipKind = ReferenceKind

// An image still uploading holds its place in the draft as an image token for a path no file has.
const PENDING_IMAGE = '/pending-image/'

export const pendingImage = ({ id }: { id: string }) => `${PENDING_IMAGE}${id}`

export const isPendingImage = ({ path }: { path: string }) => path.startsWith(PENDING_IMAGE)

export const hasPendingImage = ({ text }: { text: string }) =>
  imagePaths({ text }).some(path => isPendingImage({ path }))

export const ICON_SPACE = '\u2003'
export const QUARTER_SPACE = '\u2005'
export const CHIP_SPACE = QUARTER_SPACE + QUARTER_SPACE
const NO_BREAK_SPACE = '\u00A0'
export const WORD_JOINER = '\u2060'
export const CHIP_JOIN = WORD_JOINER + NO_BREAK_SPACE + WORD_JOINER
const NAMED_WITHOUT_AT = new Set<ChipKind>([
  'column',
  'task',
  'slot',
])
const LETTERS = new Intl.Segmenter(
  undefined,
  { granularity: 'grapheme' },
)
const WORDS = new Intl.Segmenter(
  undefined,
  { granularity: 'word' },
)

export function skillProjectLabel({ text }: { text: string }): string {
  return Array.from(
    LETTERS.segment(text),
    part => part.segment,
  ).join(WORD_JOINER)
}

export const cardChip = ({ chip }: { chip: Pick<DraftChip, 'kind' | 'attached'> }) =>
  chip.kind === 'image' || (chip.kind === 'file' && chip.attached)

export const chipText = ({ chip }: { chip: Pick<DraftChip, 'kind' | 'name'> }) =>
  NAMED_WITHOUT_AT.has(chip.kind) ? chip.name : `@${chip.name}`

interface DraftChip {
  kind: ChipKind
  // An attachment carries the image or file itself; a reference only points at something.
  attached: boolean
  value: string
  name: string
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
  const names = imageNames({ text })

  for (const match of text.matchAll(FILE_BLOCK)) {
    chips.push({
      kind: 'file',
      attached: true,
      value: match[1]!,
      name: match[1]!,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  const inside = ({ at }: { at: number }) => chips.some(chip => chip.start <= at && at < chip.end)

  for (const match of text.matchAll(IMAGE)) {
    if (!inside({ at: match.index })) {
      const named = names.get(match[1]!) ?? 'Image'
      const name = isPendingImage({ path: match[1]! }) ? `Loading ${named.toLowerCase()}` : named
      chips.push({
        kind: 'image',
        attached: true,
        value: match[1]!,
        name,
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
      const kind = match[2] as ChipKind
      const name = referenceLabel({ label: match[1]! })
      const value = decodeValue({ value: match[3]! }) ?? match[3]!

      if (kind === 'skill' && !readSkillReference({ value })) {
        continue
      }

      chips.push({
        kind,
        attached: false,
        value,
        name,
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
    display += CHIP_CHARACTER
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

function sourceOffset({
  view,
  offset,
}: {
  view: DraftView
  offset: number
}) {
  let shift = 0

  for (const chip of view.chips) {
    if (offset <= chip.from) {
      return offset + shift
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

export const displayAt = ({
  text,
  offset,
}: {
  text: string
  offset: number
}) => displayOffset({
  view: draftView({ text }),
  offset,
})

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
  const head = sourceOffset({
    view,
    offset: from,
  })
  const next = text.slice(
    0,
    head,
  ) + insert + text.slice(sourceOffset({
    view,
    offset: to,
  }))

  return {
    text: next,
    caret: displayOffset({
      view: draftView({ text: next }),
      offset: head + insert.length,
    }),
  }
}

const OPENING = /[\p{Ps}\p{Pi}]/u
const CLOSING = /[\p{Pe}\p{Pf}\p{Po}]/u

// Whole code points, so a boundary is never found inside a surrogate pair.
const pointBefore = ({
  text,
  at,
}: {
  text: string
  at: number
}) => Array.from(text.slice(
  Math.max(
    0,
    at - 2,
  ),
  at,
)).at(-1) ?? ''

const pointAt = ({
  text,
  at,
}: {
  text: string
  at: number
}) => at < text.length ? String.fromCodePoint(text.codePointAt(at)!) : ''

export function placeImages({
  text,
  caret: at,
  lines,
}: {
  text: string
  caret?: number
  lines: string[]
}) {
  const view = draftView({ text }), shown = view.display
  let caret = Math.min(
    at ?? shown.length,
    shown.length,
  )

  const word = caret > 0 ? WORDS.segment(shown).containing(caret - 1) : undefined

  if (word?.isWordLike) {
    caret = Math.max(
      caret,
      word.index + word.segment.length,
    )
  }

  const before = pointBefore({
    text: shown,
    at: caret,
  })
  const after = pointAt({
    text: shown,
    at: caret,
  })
  const chipBefore = view.chips.some(chip => chip.to === caret)
  const chipAfter = view.chips.some(chip => chip.from === caret)
  const lead = chipBefore || (/\S/u.test(before) && !OPENING.test(before)) ? ' ' : ''
  const tail = !after || chipAfter || (/\S/u.test(after) && !CLOSING.test(after)) ? ' ' : ''

  return replaceDisplay({
    text,
    from: caret,
    to: caret,
    insert: `${lead}${lines.join(' ')}${tail}`,
  })
}

export function removeChip({
  text,
  chip,
}: {
  text: string
  chip: PlacedChip
}) {
  const shown = draftView({ text }).display
  const after = pointAt({
    text: shown,
    at: chip.to,
  })
  const spaceAfter = after === ' ', spaceBefore = shown[chip.from - 1] === ' '
  // The space before goes only when nothing would then run into the previous word.
  const freeAfter = !after || /\s/u.test(after) || CLOSING.test(after)
  const from = !spaceAfter && spaceBefore && freeAfter ? chip.from - 1 : chip.from
  const to = spaceAfter ? chip.to + 1 : chip.to

  return replaceDisplay({
    text,
    from,
    to,
    insert: '',
  })
}

// The upload's answer takes its placeholder's place, or removes it when the upload failed. Text typed
// meanwhile and the selection stay where they were; undefined means the owner already removed the placeholder.
export function settleImage({
  text,
  anchor,
  focus,
  path,
  line,
}: {
  text: string
  anchor: number
  focus: number
  path: string
  line?: string
}) {
  const view = draftView({ text })
  const chip = view.chips.find(placed => placed.kind === 'image' && placed.attached && placed.value === path)

  if (!chip) {
    return undefined
  }

  const settled = line ? {
    text: text.slice(
      0,
      chip.start,
    ) + line + text.slice(chip.end),
    caret: chip.from,
  } : removeChip({
    text,
    chip,
  })
  const removed = view.display.length - draftView({ text: settled.text }).display.length
  const kept = ({ offset }: { offset: number }) => offset <= settled.caret ? offset : Math.max(
    settled.caret,
    offset - removed,
  )

  return {
    text: settled.text,
    anchor: kept({ offset: anchor }),
    focus: kept({ offset: focus }),
  }
}

// A placeholder saved with a draft lost its upload when the page closed.
// Only the given placeholders go when `paths` is set, as when one field's own uploads stop.
export function withoutPendingImages({
  text,
  paths,
}: {
  text: string
  paths?: Set<string>
}) {
  let rest = text

  const leaving = imagePaths({ text })
    .filter(path => isPendingImage({ path }) && (!paths || paths.has(path)))

  for (const path of leaving) {
    rest = settleImage({
      text: rest,
      anchor: 0,
      focus: 0,
      path,
    })?.text ?? rest
  }

  return rest
}

// For a rich-text app a chip reads as it shows and an attached file keeps its contents; `image` stands an
// attached image in for its name.
export function shownDraft({
  text,
  image,
}: {
  text: string
  image({
    path,
    name,
  }: {
    path: string
    name: string
  }): string
}) {
  let drawn = '', cursor = 0

  for (const chip of draftChips({ text })) {
    const attachedFile = chip.kind === 'file' && chip.attached
    const attachedImage = chip.kind === 'image' && chip.attached
    const reference = chip.attached || chip.kind === 'skill' ? chip.name : chipText({ chip })
    const shown = attachedImage ? image({
      path: chip.value,
      name: chip.name,
    }) : reference
    drawn += text.slice(
      cursor,
      chip.start,
    ) + (attachedFile ? text.slice(
      chip.start,
      chip.end,
    ) : shown)
    cursor = chip.end
  }

  return drawn + text.slice(cursor)
}

// A selection that touches a chip copies the whole chip as its Markdown; undefined means it holds none and
// copies as it shows.
export function copyDraft({
  text,
  from,
  to,
}: {
  text: string
  from: number
  to: number
}) {
  const view = draftView({ text })
  const holdsChip = view.chips.some(chip => from < chip.to && to > chip.from)

  if (!holdsChip) {
    return undefined
  }

  return withoutPendingImages({
    text: text.slice(
      sourceOffset({
        view,
        offset: from,
      }),
      sourceOffset({
        view,
        offset: to,
      }),
    ),
  })
}

// The newlines that make a block its own paragraph, after the ones already there.
const paragraphBreak = ({ newlines }: { newlines: string }) => '\n'.repeat(2 - newlines.length)

// A text file counts only as its own paragraph, so it goes after the caret's line and never splits a word.
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
