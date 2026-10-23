import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { imageNames } from '../../../../src/attachments/images.ts'
import { Markdown, MarkdownBlocks, markdown } from './markdown.tsx'
import {
  EDGE,
  WINDOW,
  fencedTail,
  mountShown,
  revealSpeed,
  revealStep,
  safeEnd,
  splitBlocks,
  type Block,
} from './reveal.ts'

type MarkdownProps = ComponentProps<typeof Markdown>

const lex = ({ text }: { text: string }) => markdown.lexer(text)

const useReducedMotion = () => {
  const [
    reduced,
    setReduced,
  ] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(
    () => {
      const media = matchMedia('(prefers-reduced-motion: reduce)')
      const change = () => setReduced(media.matches)
      media.addEventListener(
        'change',
        change,
      )

      return () => media.removeEventListener(
        'change',
        change,
      )
    },
    [],
  )

  return reduced
}

// A message that mounts settled renders as plain Markdown; one that mounts streaming
// types in and keeps its typing state for as long as it stays mounted.
export function MessageText({
  streaming,
  decorations,
  ...props
}: MarkdownProps & {
  streaming?: boolean
  // Text inside these elements is not message text (comment cards, code labels).
  decorations?: string
}) {
  const [streamed] = useState(!!streaming)

  return streamed ? (
    <StreamedText
      {...props}
      streaming={!!streaming}
      decorations={decorations ?? '.code-language'}
    />
  ) : <Markdown {...props} />
}

type Reveal = {
  text: string
  streaming: boolean
  ended: boolean
  decorations: string
  // Typed position (fractional) and how much text the DOM holds, both in source chars.
  cursor: number
  shown: number
  speed: number
  arrivals: {
    t: number
    len: number
  }[]
  boundary: number
  done: Block[]
  live: Block
  fenced: boolean
  frame: number
  last: number
  // Rendered (DOM) text: its length after the last commit, and how much of it is typed.
  rendered: number
  visible: number
  typed: {
    t: number
    visible: number
  }[]
  ranges: Range[]
}

// Letters typed in the last EDGE ms ramp up in four steps by position; untyped letters
// are laid out but transparent. One shared Highlight per level holds every message's ranges.
const LEVELS = [
  'reveal-0',
  'reveal-1',
  'reveal-2',
  'reveal-3',
  'reveal-hide',
]

const highlight = ({ name }: { name: string }) => {
  let found = CSS.highlights.get(name)

  if (!found) {
    found = new Highlight()
    CSS.highlights.set(
      name,
      found,
    )
  }

  return found
}

const unpaint = ({ st }: { st: Reveal }) => {
  if (typeof CSS === 'undefined' || !CSS.highlights) {
    return
  }

  st.ranges.forEach((
    range,
    k,
  ) => CSS.highlights.get(LEVELS[k]!)?.delete(range))
}

// Message text nodes, skipping those inside decorations.
const textNodes = function* ({
  host,
  decorations,
  backwards = false,
}: {
  host: HTMLElement
  decorations: string
  backwards?: boolean
}) {
  const walker = document.createTreeWalker(
    host,
    NodeFilter.SHOW_TEXT,
  )
  let node = backwards ? walker.lastChild() : walker.nextNode()

  while (node) {
    if (!node.parentElement?.closest(decorations)) {
      yield node as Text
    }

    node = backwards ? walker.previousNode() : walker.nextNode()
  }
}

const renderedLength = ({
  host,
  decorations,
}: {
  host: HTMLElement
  decorations: string
}) => {
  let length = 0

  for (const node of textNodes({
    host,
    decorations,
  })) {
    length += node.data.length
  }

  return length
}

// DOM points for distances back from the end of the rendered text, walking text nodes
// backwards: the ranges only ever cover the last few words.
const pointsFromEnd = ({
  host,
  decorations,
  distances,
}: {
  host: HTMLElement
  decorations: string
  distances: number[]
}) => {
  const found = new Map<number, [Text, number]>()
  const farthest = Math.max(...distances)
  let after = 0, first: Text | undefined

  for (const node of textNodes({
    host,
    decorations,
    backwards: true,
  })) {
    const length = node.data.length
    first = node

    for (const distance of distances) {
      if (!found.has(distance) && distance <= after + length) {
        let at = length - (distance - after)

        // Never split a surrogate pair.
        if (at > 0 && at < length && /[\uD800-\uDBFF]/.test(node.data[at - 1]!)) {
          at++
        }

        found.set(
          distance,
          [
            node,
            at,
          ],
        )
      }
    }

    after += length

    if (after >= farthest) {
      break
    }
  }

  // A distance past the start of the text covers all of it.
  for (const distance of distances) {
    if (!found.has(distance) && first) {
      found.set(
        distance,
        [
          first,
          0,
        ],
      )
    }
  }

  return found
}

const paint = ({
  st,
  host,
  now,
}: {
  st: Reveal
  host: HTMLElement | null
  now: number
}) => {
  if (!host || typeof CSS === 'undefined' || !CSS.highlights) {
    return
  }

  // Unrendered markup between the cursor and the DOM end makes this an estimate;
  // never decreasing, it turns into a short pause of the edge, never a letter vanishing.
  st.visible = Math.min(
    st.rendered,
    Math.max(
      st.visible,
      st.rendered - Math.ceil(st.shown - st.cursor),
    ),
  )

  if (st.typed.at(-1)?.visible !== st.visible) {
    st.typed.push({
      t: st.typed.length ? now : -Infinity,
      visible: st.visible,
    })
  }

  const old = st.typed.findLastIndex(sample => sample.t <= now - EDGE)
  st.typed = st.typed.slice(Math.max(
    0,
    old,
  ))
  const edge = st.visible - st.typed[0]!.visible
  const hidden = st.rendered - st.visible
  const spans = [
    0,
    1,
    2,
    3,
  ].map(k => [
    hidden + Math.round(edge * (k + 1) / 4),
    hidden + Math.round(edge * k / 4),
  ])
  spans.push([
    hidden,
    0,
  ])
  const points = pointsFromEnd({
    host,
    decorations: st.decorations,
    distances: spans.flat(),
  })

  spans.forEach((
    [
      from,
      to,
    ],
    k,
  ) => {
    const store = highlight({ name: LEVELS[k]! })
    const range = st.ranges[k] ??= new Range()
    const start = points.get(from!), end = points.get(to!)
    store.delete(range)

    if (from! > to! && start && end) {
      range.setStart(
        start[0],
        start[1],
      )
      range.setEnd(
        end[0],
        end[1],
      )
      store.add(range)
    }
  })
}

const settled = ({ st }: { st: Reveal }) => st.cursor >= st.text.length
  && st.typed.length < 2 && st.visible >= st.rendered

type Loop = {
  st: Reveal
  host: RefObject<HTMLDivElement | null>
  render(): void
}

const schedule = ({
  st,
  host,
  render,
}: Loop) => {
  if (!st.frame && !settled({ st })) {
    st.frame = requestAnimationFrame(time => tick({
      st,
      host,
      render,
      time,
    }))
  }
}

const split = ({ st }: { st: Reveal }) => {
  const result = splitBlocks({
    text: st.text.slice(
      0,
      st.shown,
    ),
    boundary: st.boundary,
    done: st.done,
    lex,
  })
  st.boundary = result.boundary
  st.live = result.live
  st.fenced = result.fenced
}

// Everything that has arrived, held back by the tail check.
const arrived = ({ st }: { st: Reveal }) => safeEnd({
  text: st.text,
  end: st.text.length,
  final: !st.streaming,
  fenced: fencedTail({
    text: st.text,
    boundary: st.boundary,
    lex,
  }),
})

function tick({
  st,
  host,
  render,
  time,
}: Loop & { time: number }) {
  const elapsed = st.last ? time - st.last : 1000 / 60
  st.frame = 0
  st.last = time
  const step = revealStep({
    text: st.text,
    cursor: st.cursor,
    shown: st.shown,
    speed: st.speed,
    elapsed,
    final: !st.streaming,
    fenced: st.fenced,
  })
  st.cursor = step.cursor

  // A new DOM end paints in its commit; otherwise only the typed letters moved.
  if (step.shown !== st.shown) {
    st.shown = step.shown
    split({ st })
    render()
  } else {
    paint({
      st,
      host: host.current,
      now: time,
    })
  }

  if (settled({ st })) {
    st.last = 0
    unpaint({ st })
  } else {
    schedule({
      st,
      host,
      render,
    })
  }
}

// The streaming reply types word by word at the measured arrival rate, catching up
// within CATCHUP and finishing within FINISH. Half-written Markdown waits, completed
// blocks render once, and the typing is painted with CSS highlights, never DOM changes.
function StreamedText({
  text,
  streaming,
  decorations,
  block,
  openTask,
  columnLook,
}: MarkdownProps & {
  streaming: boolean
  decorations: string
}) {
  const [
    ,
    setFrame,
  ] = useState(0)
  const render = () => setFrame(n => n + 1)
  const reduced = useReducedMotion()
  const host = useRef<HTMLDivElement>(null)
  const state = useRef<Reveal | null>(null)
  const images = useMemo(
    () => imageNames({ text }),
    [text],
  )

  if (!state.current) {
    const shown = mountShown({
      text,
      streaming: streaming && !reduced,
      lex,
    })
    state.current = {
      text,
      streaming,
      ended: !streaming,
      decorations,
      cursor: shown,
      shown,
      speed: 0,
      arrivals: [
        {
          t: -Infinity,
          len: shown,
        },
      ],
      boundary: 0,
      done: [],
      live: {
        offset: 0,
        index: 0,
        raw: '',
        tokens: [],
      },
      fenced: false,
      frame: 0,
      last: 0,
      rendered: 0,
      visible: 0,
      typed: [],
      ranges: [],
    }

    if (reduced && streaming) {
      state.current.shown = state.current.cursor = arrived({ st: state.current })
    }

    split({ st: state.current })
  }

  useLayoutEffect(
    () => {
      const st = state.current!
      const now = performance.now()
      const grew = text.length !== st.arrivals.at(-1)!.len
      const rewritten = !text.startsWith(st.text.slice(
        0,
        st.shown,
      ))
      st.text = text
      st.streaming = streaming
      st.decorations = decorations

      // Reduced motion shows text push by push; a harness that rewrote the text
      // instead of extending it gets it shown as it is.
      if (reduced || rewritten) {
        cancelAnimationFrame(st.frame)
        unpaint({ st })
        Object.assign(
          st,
          {
            frame: 0,
            last: 0,
            typed: [],
            visible: 0,
            ...rewritten ? {
              boundary: 0,
              done: [],
              shown: 0,
            } : {},
          },
        )
        st.shown = st.cursor = Math.max(
          st.shown,
          arrived({ st }),
        )
        st.arrivals = [
          {
            t: now,
            len: text.length,
          },
        ]
        split({ st })
        render()

        return
      }

      if (grew) {
        st.arrivals.push({
          t: now,
          len: text.length,
        })
      }

      const old = st.arrivals.findLastIndex(arrival => arrival.t <= now - WINDOW)
      st.arrivals = st.arrivals.slice(Math.max(
        0,
        old,
      ))
      const rate = (text.length - st.arrivals[0]!.len) / WINDOW

      // The speed holds between pushes; once the reply ends it is fixed to finish in time.
      if (streaming || !st.ended || grew) {
        st.ended = !streaming
        st.speed = revealSpeed({
          rate,
          backlog: text.length - st.cursor,
          ended: !streaming,
        })
      }

      schedule({
        st,
        host,
        render,
      })
    },
    [
      text,
      streaming,
      reduced,
      decorations,
    ],
  )

  // Paint in the commit itself, so a commit never shows untyped letters for a frame.
  useLayoutEffect(() => {
    const st = state.current!

    if (!host.current || reduced) {
      return
    }

    st.rendered = renderedLength({
      host: host.current,
      decorations: st.decorations,
    })
    paint({
      st,
      host: host.current,
      now: performance.now(),
    })
    schedule({
      st,
      host,
      render,
    })
  })

  useEffect(
    () => () => {
      const st = state.current!
      cancelAnimationFrame(st.frame)
      st.frame = st.last = 0
      unpaint({ st })
    },
    [],
  )

  const st = state.current

  return (
    <div className="markdown" ref={host}>
      {[
        ...st.done,
        ...st.live.raw ? [st.live] : [],
      ].map(part => (
        <MarkdownBlocks
          key={part.offset}
          text={part.raw}
          tokens={part.tokens}
          offset={part.offset}
          index={part.index}
          block={block}
          openTask={openTask}
          columnLook={columnLook}
          images={images}
        />
      ))}
    </div>
  )
}

export function WorkingDots() {
  return <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
}
