import { readSkillReference } from '#hydra/transcripts-skill-reference.ts'
import { IMAGE, imageNames, imagePaths } from '#hydra/images.ts'
import { FILE_BLOCK } from '#hydra/attachments.ts'
import { decodeValue, REFERENCE, referenceLabel, type ReferenceKind } from '#hydra/mentions.ts'

// The draft stays the Markdown Hydra receives; the textarea shows each chip as its label.
export type ChipKind = ReferenceKind

// An image still uploading holds its place in the draft as an image token for a path no file has.
const PENDING_IMAGE = '/pending-image/'

export const pendingImage = ({ id }: { id: string }) => `${PENDING_IMAGE}${id}`

export const isPendingImage = ({ path }: { path: string }) => path.startsWith(PENDING_IMAGE)

export const hasPendingImage = ({ text }: { text: string }) =>
  imagePaths({ text }).some(path => isPendingImage({ path }))

// An em space holds an icon's room in the textarea (a task chip has two); the chip draws icons over them.
export const ICON_SPACE = '\u2003'
export const QUARTER_SPACE = '\u2005'
export const CHIP_SPACE = QUARTER_SPACE + QUARTER_SPACE
const NO_BREAK_SPACE = '\u00A0'
export const WORD_JOINER = '\u2060'
export const CHIP_JOIN = WORD_JOINER + NO_BREAK_SPACE + WORD_JOINER
const REFERENCE_ROOM: Partial<Record<ChipKind, string>> = {
  column: ICON_SPACE + CHIP_JOIN,
  task: ICON_SPACE + WORD_JOINER + ICON_SPACE + CHIP_JOIN,
  slot: '',
}
const CARD_NAME_MAX = 20
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

// A card is drawn as one box over this room, so word joiners keep it on one line and a long name is cut.
export function cardLabel({ name }: { name: string }) {
  const letters = Array.from(
    LETTERS.segment(name),
    letter => letter.segment === ' ' ? NO_BREAK_SPACE : letter.segment,
  )
  const shown = letters.length > CARD_NAME_MAX ? [
    ...letters.slice(
      0,
      CARD_NAME_MAX - 1,
    ),
    '…',
  ] : letters

  return [
    ICON_SPACE,
    ICON_SPACE,
    QUARTER_SPACE,
    ...shown,
    ICON_SPACE,
    ICON_SPACE,
  ].join(WORD_JOINER)
}

interface DraftChip {
  kind: ChipKind
  // An attachment carries the image or file itself; a reference only points at something.
  attached: boolean
  value: string
  // What the chip is called; its label adds the room the chip draws its icons and controls over.
  name: string
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
  const names = imageNames({ text })

  for (const match of text.matchAll(FILE_BLOCK)) {
    chips.push({
      kind: 'file',
      attached: true,
      value: match[1]!,
      name: match[1]!,
      label: cardLabel({ name: match[1]! }),
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
        label: cardLabel({ name }),
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
      const skill = kind === 'skill' ? readSkillReference({ value }) : undefined

      if (kind === 'skill' && !skill) {
        continue
      }

      const prefix = REFERENCE_ROOM[kind] ?? '@'
      let label = `${prefix}${name}`

      if (skill) {
        const project = skill.project ? skillProjectLabel({ text: skill.project }) + CHIP_JOIN : ''
        label = `${ICON_SPACE}${CHIP_JOIN}${project}/${skill.name}${CHIP_JOIN}${ICON_SPACE}`
      }

      chips.push({
        kind,
        attached: false,
        value,
        name,
        label: cardChip({
          chip: {
            kind,
            attached: false,
          },
        }) ? cardLabel({ name }) : label,
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
    display += CHIP_SPACE + chip.label + CHIP_SPACE
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

// A caret never rests inside a chip: it moves to the edge it was heading for.
function snapCaret({
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

// A selection never ends inside a chip: its moving end jumps over a chip the way it was heading, and its
// fixed end widens to take the whole chip.
export function snapSelection({
  view,
  anchor,
  focus,
  previous,
}: {
  view: DraftView
  anchor: number
  focus: number
  previous: number
}) {
  const moved = snapCaret({
    view,
    offset: focus,
    backward: focus < previous,
  })

  if (anchor === focus) {
    return {
      anchor: moved,
      focus: moved,
    }
  }

  return {
    anchor: snapCaret({
      view,
      offset: anchor,
      backward: moved > anchor,
    }),
    focus: moved,
  }
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

  caret = snapCaret({
    view,
    offset: caret,
    backward: false,
  })
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
export function withoutPendingImages({ text }: { text: string }) {
  let rest = text

  for (const path of imagePaths({ text }).filter(path => isPendingImage({ path }))) {
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
    const shownBare = chip.attached || chip.kind === 'skill' || REFERENCE_ROOM[chip.kind] !== undefined
    const reference = shownBare ? chip.name : `@${chip.name}`
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
  const touched = view.chips.filter(chip => from < chip.to && to > chip.from)

  if (!touched.length) {
    return undefined
  }

  return withoutPendingImages({
    text: text.slice(
      sourceOffset({
        view,
        offset: Math.min(
          from,
          ...touched.map(chip => chip.from),
        ),
      }),
      sourceOffset({
        view,
        offset: Math.max(
          to,
          ...touched.map(chip => chip.to),
        ),
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
  const view = draftView({ text }), before = view.display
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

  const to = before.length - suffix
  const insert = next.slice(
    prefix,
    next.length - suffix,
  )
  const erased = insert || prefix === to ? undefined
    : view.chips.find(chip => cardChip({ chip }) && chip.from <= prefix && to <= chip.to)

  return erased ? removeChip({
    text,
    chip: erased,
  }) : replaceDisplay({
    text,
    from: prefix,
    to,
    insert,
  })
}
