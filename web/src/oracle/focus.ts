export const INPUT = 'input'

export type FocusMove = 'next' | 'previous' | 'escape'

// Focus outside the cycle counts as the input, so a stray focus always rejoins it.
export function moveFocus<T>({
  controls,
  from,
  move,
}: {
  controls: T[]
  from: T | typeof INPUT
  move: FocusMove
}): T | typeof INPUT {
  if (move === 'escape') {
    return INPUT
  }

  const order: (T | typeof INPUT)[] = [
    INPUT,
    ...controls,
  ]
  const at = Math.max(
    0,
    order.indexOf(from),
  )
  const step = move === 'next' ? 1 : -1

  return order[(at + step + order.length) % order.length]!
}

export function recoverFocus<T>({
  before,
  controls,
  lost,
}: {
  // The controls when the lost one last had focus.
  before: T[]
  controls: T[]
  lost: T
}): T | typeof INPUT {
  const after = before.slice(before.indexOf(lost) + 1)

  return after.find(control => controls.includes(control)) ?? INPUT
}

// These controls use ← → themselves: a slider's value, a text field's caret, a radio group's option.
export type ControlKind = 'slider' | 'text' | 'radio' | 'other'

const NOT_TEXT = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]

export function controlKind({
  tag,
  type = '',
  role,
}: {
  tag: string
  type?: string
  role?: string | null
}): ControlKind {
  const name = tag.toLowerCase()

  if (role === 'radio' || (name === 'input' && type === 'radio')) {
    return 'radio'
  }

  if (name === 'textarea') {
    return 'text'
  }

  if (name !== 'input') {
    return 'other'
  }

  if (type === 'range') {
    return 'slider'
  }

  return NOT_TEXT.includes(type) ? 'other' : 'text'
}

// The control keeps the key, as a slider keeps ← and → and an open popup keeps every arrow.
export const PASS = 'pass'

// ↓ stops on the last control rather than wrapping, so holding it never lands back in the bar.
export function arrowFocus<T>({
  controls,
  from,
  key,
  kind,
  popup = false,
}: {
  controls: T[]
  from: T
  key: string
  kind: ControlKind
  // The focused control has its own popup open, such as a Select's menu.
  popup?: boolean
}): T | typeof INPUT | typeof PASS {
  if (popup) {
    return PASS
  }

  if (key === 'ArrowLeft') {
    return kind === 'other' ? INPUT : PASS
  }

  if (key === 'ArrowUp') {
    return moveFocus({
      controls,
      from,
      move: 'previous',
    })
  }

  if (key !== 'ArrowDown') {
    return PASS
  }

  const at = controls.indexOf(from)

  return controls[Math.min(
    at + 1,
    controls.length - 1,
  )] ?? from
}

// Where → or Enter enters a preview: a setting's own control before its Reset to default, else the first control.
export const enterPreview = <T>({
  controls,
  own,
}: {
  controls: T[]
  // The controls inside the setting's own control area.
  own: T[]
}): T | undefined => own[0] ?? controls[0]

export const SCROLL_BUFFER = 2

export interface Row {
  // From the top of the scrolled content.
  top: number
  height: number
}

// Near the first row the pane scrolls to its top, so the first group's heading stays in view.
export function bufferedScroll({
  scrollTop,
  viewport,
  rows,
  index,
  buffer = SCROLL_BUFFER,
}: {
  scrollTop: number
  viewport: number
  rows: Row[]
  index: number
  buffer?: number
}): number {
  if (!rows[index]) {
    return scrollTop
  }

  const spans = Array.from(
    { length: buffer + 1 },
    (
      _,
      step,
    ) => {
      const keep = buffer - step
      const first = Math.max(
        0,
        index - keep,
      )
      const last = rows[Math.min(
        rows.length - 1,
        index + keep,
      )]!

      return {
        top: first === 0 ? 0 : rows[first]!.top,
        bottom: last.top + last.height,
      }
    },
  )
  const span = spans.find(item => item.bottom - item.top <= viewport) ?? spans.at(-1)!

  if (span.top < scrollTop || span.bottom - span.top > viewport) {
    return span.top
  }

  if (span.bottom > scrollTop + viewport) {
    return span.bottom - viewport
  }

  return scrollTop
}
