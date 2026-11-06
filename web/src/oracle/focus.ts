import { useEffect, type RefObject, type Dispatch, type SetStateAction, type KeyboardEvent } from 'react'
import { composing } from '#web-shared/ime.ts'

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

// ← → move a slider, a caret or a radio group's option, and an open popup such as a Select's menu keeps every arrow.
export type ControlKind = 'popup' | 'slider' | 'text' | 'radio' | 'other'

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
  expanded = false,
  popup = false,
}: {
  tag: string
  type?: string
  role?: string | null
  expanded?: boolean
  // The control declares a popup with aria-haspopup.
  popup?: boolean
}): ControlKind {
  const name = tag.toLowerCase()

  // An expanded disclosure, such as "Show fewer", is not a popup and leaves the arrows to the palette.
  if (expanded && (popup || role === 'combobox')) {
    return 'popup'
  }

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

// A multi-line field's text and selection, as offsets into it.
interface Caret {
  value: string
  start: number
  end: number
}

// A multi-line field keeps ↑ ↓ for its caret until the caret reaches its first or last line.
const caretMoves = ({
  key,
  caret,
}: {
  key: string
  caret: Caret
}) => key === 'ArrowUp'
  ? caret.value.slice(
    0,
    caret.start,
  ).includes('\n')
  : caret.value.slice(caret.end).includes('\n')

// ↓ stops on the last control rather than wrapping, so holding it never lands back in the bar.
export function arrowFocus<T>({
  controls,
  from,
  key,
  kind,
  lines,
}: {
  controls: T[]
  from: T
  key: string
  kind: ControlKind
  lines?: Caret
}): T | typeof INPUT | typeof PASS {
  if (kind === 'popup') {
    return PASS
  }

  if (key === 'ArrowLeft') {
    return kind === 'other' ? INPUT : PASS
  }

  const vertical = key === 'ArrowUp' || key === 'ArrowDown'

  if (vertical && lines && caretMoves({
    key,
    caret: lines,
  })) {
    return PASS
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

const SCROLL_BUFFER = 2

interface Row {
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
        top: first === 0 && keep > 0 ? 0 : rows[first]!.top,
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

const FOCUSABLE = 'a[href], button, input, textarea, [tabindex]'
const ARROWS = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]

export const keepInView = ({
  container,
  items,
  focus,
}: {
  container: HTMLElement
  items: HTMLElement[]
  focus: HTMLElement
}) => {
  const box = container.getBoundingClientRect()

  container.scrollTop = bufferedScroll({
    scrollTop: container.scrollTop,
    viewport: container.clientHeight,
    rows: items.map(item => {
      const rect = item.getBoundingClientRect()

      return {
        top: rect.top - box.top + container.scrollTop,
        height: rect.height,
      }
    }),
    index: items.indexOf(focus),
  })
}

export function usePreviewFocus({
  preview,
  input,
  focused,
  setInPreview,
  setQuery,
  open,
}: {
  preview: RefObject<HTMLDivElement | null>
  input: RefObject<HTMLInputElement | null>
  focused: RefObject<{
    control: HTMLElement
    before: HTMLElement[]
  } | null>
  setInPreview: Dispatch<SetStateAction<boolean>>
  setQuery: Dispatch<SetStateAction<string>>
  open: boolean
}) {
  // A roving item (tabindex -1) is reached through the one that stands for its group.
  const previewControls = () => [...preview.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    .filter(element => element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.checkVisibility())

  const focusStop = ({ to }: { to: HTMLElement | typeof INPUT }) => {
    if (to === INPUT) {
      focused.current = null
      setInPreview(false)
      input.current?.focus()
    } else {
      to.focus()
    }
  }

  const focusPreview = () => {
    const controls = previewControls()

    enterPreview({
      controls,
      own: controls.filter(control => control.closest('.setting-control')),
    })?.focus()
  }

  // A focused control that unmounts or is disabled would leave focus nowhere the keyboard can leave, so it moves on.
  useEffect(
    () => {
      const node = preview.current

      if (!open || !node) {
        return
      }

      const observer = new MutationObserver(() => {
        const last = focused.current

        if (!last) {
          return
        }

        const controls = previewControls()
        const active = document.activeElement

        if (controls.includes(last.control)) {
          last.before = controls

          return
        }

        if (active instanceof HTMLElement && active !== last.control && controls.includes(active)) {
          focused.current = {
            control: active,
            before: controls,
          }

          return
        }

        focusStop({
          to: recoverFocus({
            before: last.before,
            controls,
            lost: last.control,
          }),
        })
      })
      observer.observe(
        node,
        {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            'disabled',
            'tabindex',
            'hidden',
            'class',
            'style',
          ],
        },
      )

      return () => observer.disconnect()
    },
    [open],
  )

  const cycleFocus = ({ event }: { event: KeyboardEvent<HTMLDialogElement> }) => {
    const controls = previewControls()
    const control = controls.find(item => item === event.target)

    event.preventDefault(); event.stopPropagation()
    focusStop({
      to: moveFocus({
        controls,
        from: control ?? INPUT,
        move: event.shiftKey ? 'previous' : 'next',
      }),
    })
  }

  // Runs before the control's own keys, so a closed Select or a radio group doesn't take ↑ ↓ for itself.
  const previewArrow = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    const { target } = event
    const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    const typing = composing({ event: event.nativeEvent })
    const plainArrow = ARROWS.includes(event.key) && !modified && !typing

    if (!plainArrow || !(target instanceof HTMLElement)) {
      return
    }

    const to = arrowFocus({
      controls: previewControls(),
      from: target,
      key: event.key,
      kind: controlKind({
        tag: target.tagName,
        type: target instanceof HTMLInputElement ? target.type : undefined,
        role: target.getAttribute('role'),
        expanded: target.getAttribute('aria-expanded') === 'true',
        popup: ![
          null,
          'false',
        ].includes(target.getAttribute('aria-haspopup')),
      }),
      lines: target instanceof HTMLTextAreaElement ? {
        value: target.value,
        start: target.selectionStart,
        end: target.selectionEnd,
      } : undefined,
    })

    if (to === PASS) {
      return
    }

    event.preventDefault(); event.stopPropagation()

    if (to !== target) {
      focusStop({ to })
    }
  }

  // A control that closed its own popup on this Esc already kept the key, so only the next Esc returns.
  const previewKey = ({ event }: { event: KeyboardEvent<HTMLDivElement> }) => {
    if (composing({ event: event.nativeEvent })) {
      return
    }

    const { target } = event
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    const typed = event.key.length === 1 && event.key !== ' ' && plain && !field && !event.nativeEvent.defaultPrevented

    if (event.key !== 'Escape' && !typed) {
      return
    }

    event.preventDefault(); event.stopPropagation()

    if (typed) {
      // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
      setQuery(value => value + event.key)
    }

    focusStop({
      to: moveFocus({
        controls: previewControls(),
        from: INPUT,
        move: 'escape',
      }),
    })
  }

  return {
    previewControls,
    focusPreview,
    cycleFocus,
    previewArrow,
    previewKey,
  }
}
