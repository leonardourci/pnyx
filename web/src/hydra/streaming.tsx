import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react'
import { shownImageNames } from '#hydra/images.ts'
import { Markdown, MarkdownBlocks, markdown } from './markdown.tsx'
import {
  EDGE,
  arrivalRate,
  fencedTail,
  mountShown,
  revealSpeed,
  revealStep,
  safeEnd,
  splitBlocks,
  type Arrival,
  type Block,
} from '#web-shared/ui/reveal.ts'

type MarkdownProps = ComponentProps<typeof Markdown>

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const FRAME = 1000 / 60

const lex = ({ text }: { text: string }) => markdown.lexer(text)

const useReducedMotion = () => {
  const [
    reduced,
    setReduced,
  ] = useState(() => matchMedia(REDUCED_MOTION).matches)

  useEffect(
    () => {
      const media = matchMedia(REDUCED_MOTION)
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

// Only a message that mounts streaming types in; it keeps typing state while it stays mounted.
export function MessageText({
  streaming,
  decorations,
  ...props
}: MarkdownProps & {
  streaming?: boolean
  // Selector for elements inside a block that are not message text.
  decorations: string
}) {
  const [streamed] = useState(!!streaming)

  return streamed ? (
    <StreamedText
      {...props}
      streaming={!!streaming}
      decorations={decorations}
    />
  ) : <Markdown {...props} />
}

type Reveal = {
  text: string
  streaming: boolean
  ended: boolean
  decorations: string
  // Both in source chars: the typed position (fractional) and how much text the DOM holds.
  cursor: number
  shown: number
  speed: number
  arrivals: Arrival[]
  boundary: number
  done: Block[]
  live: Block
  fenced: boolean
  frame: number
  last: number
  // In rendered (DOM) chars: the length after the last commit, and how much of it is typed.
  rendered: number
  visible: number
  typed: {
    t: number
    visible: number
  }[]
  ranges: Range[]
}

// One shared Highlight per level holds every message's ranges, so messages never clear each other's.
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
  if (!CSS.highlights) {
    return
  }

  st.ranges.forEach((
    range,
    k,
  ) => CSS.highlights.get(LEVELS[k]!)?.delete(range))
}

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

// Walks back from the end: the ranges only ever cover the last few words.
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
  if (!host || !CSS.highlights) {
    return
  }

  // Unrendered markup makes this an estimate; never decreasing, it can pause the edge but never hide a letter again.
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
    const range = st.ranges[k]!
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
  const elapsed = st.last ? time - st.last : FRAME
  const before = st.cursor, held = st.shown
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

  // Held text waits for the next push, whose layout effect starts the loop again.
  const stuck = st.cursor === before && st.shown === held && st.typed.length < 2

  if (settled({ st })) {
    st.last = 0
    unpaint({ st })
  } else if (stuck) {
    st.last = 0
  } else {
    schedule({
      st,
      host,
      render,
    })
  }
}

// Typing is painted with CSS highlights so the DOM, caret and comment anchors never change.
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
    () => shownImageNames({ text }),
    [text],
  )

  if (!state.current) {
    const shown = mountShown({
      text,
      fromStart: !reduced,
      lex,
    })
    state.current = {
      text,
      streaming,
      ended: false,
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
      ranges: LEVELS.map(() => new Range()),
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

      // Reduced motion shows each push as it lands; text a harness rewrote shows as it is.
      if (reduced || rewritten) {
        cancelAnimationFrame(st.frame)
        unpaint({ st })
        st.frame = st.last = st.visible = 0
        st.typed = []

        if (rewritten) {
          st.boundary = st.shown = 0
          st.done = []
        }

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

      const rate = arrivalRate({
        arrivals: st.arrivals,
        now,
        length: text.length,
      })

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
  const parts = st.live.raw ? [
    ...st.done,
    st.live,
  ] : st.done

  return (
    <div className="markdown" ref={host}>
      {parts.map(part => (
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
