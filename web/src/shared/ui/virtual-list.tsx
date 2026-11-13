import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { virtualWindow } from './virtual-window.ts'

const ESTIMATE = 72
const OVERSCAN = 480
const MINIMUM = 40
// How many rows from an edge of the rendered rows count as reaching it.
const EDGE_ROWS = 6

const KEY = 'data-virtual'

const isPage = ({ element }: { element: HTMLElement }) => element === document.documentElement

// Where the scroller's visible area begins on the screen.
const edgeOf = ({ element }: { element: HTMLElement }) => isPage({ element })
  ? 0
  : element.getBoundingClientRect().top

function scroller({ element }: { element: HTMLElement }): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY

    if (overflow === 'auto' || overflow === 'scroll') {
      return parent
    }
  }

  return document.documentElement
}

// A list that keeps only the rows near the viewport on the page: the rows above and below stand in as two spacers.
// Rows are measured as they show, so a row of any height works, and the first visible row stays where it is when
// rows above it appear, change height or join the list.
export function VirtualList<T>({
  items,
  itemKey,
  render,
  onEdge,
  estimate = ESTIMATE,
  stayAtTop = false,
  ...props
}: {
  items: readonly T[]
  itemKey({ item }: { item: T }): string
  // Draws one row, a list item that spreads `virtual` so the list can measure it.
  render({
    item,
    index,
    virtual,
  }: {
    item: T
    index: number
    virtual: Record<string, string>
  }): ReactNode
  // The rows reached the first or the last of the list, which is when the next page should load.
  onEdge?({ edge }: { edge: 'start' | 'end' }): void
  estimate?: number
  // A list scrolled to its very top keeps showing its first row when rows join above it, as a feed of newest rows does.
  stayAtTop?: boolean
} & Omit<HTMLAttributes<HTMLOListElement>, 'children'>) {
  const list = useRef<HTMLOListElement>(null)
  const sizes = useRef(new Map<string, number>())
  const anchor = useRef<{
    key: string
    top: number
  } | null>(null)
  const keys = items.map(item => itemKey({ item }))
  const [
    view,
    setView,
  ] = useState({
    top: 0,
    bottom: 1200,
  })
  const [
    ,
    measured,
  ] = useState(0)
  const range = virtualWindow({
    keys,
    sizes: sizes.current,
    estimate,
    top: view.top,
    bottom: view.bottom,
    overscan: OVERSCAN,
    minimum: MINIMUM,
  })

  const viewport = () => {
    const element = list.current

    if (!element) {
      return undefined
    }

    const parent = scroller({ element })
    const above = Math.max(
      0,
      edgeOf({ element: parent }) - element.getBoundingClientRect().top,
    )

    return {
      parent,
      top: above,
      bottom: above + (isPage({ element: parent }) ? globalThis.innerHeight : parent.clientHeight),
    }
  }

  // The first row in view and where it sits, so what moves it can be undone.
  const anchored = () => {
    const element = list.current
    const read = viewport()

    if (!element || !read) {
      return
    }

    const edge = edgeOf({ element: read.parent })

    for (const row of element.querySelectorAll<HTMLElement>(`:scope > [${KEY}]`)) {
      const box = row.getBoundingClientRect()

      if (box.height > 0 && box.bottom > edge) {
        anchor.current = {
          key: row.getAttribute(KEY)!,
          top: box.top - edge,
        }

        return
      }
    }
  }

  useLayoutEffect(() => {
    const element = list.current

    if (!element) {
      return
    }

    let changed = false

    for (const row of element.querySelectorAll<HTMLElement>(`:scope > [${KEY}]`)) {
      const key = row.getAttribute(KEY)!
      const height = row.getBoundingClientRect().height

      if (sizes.current.get(key) !== height) {
        sizes.current.set(
          key,
          height,
        )
        changed = true
      }
    }

    const read = viewport()
    const held = anchor.current

    if (read && held && !(stayAtTop && read.parent.scrollTop === 0)) {
      const row = element.querySelector<HTMLElement>(`:scope > [${KEY}="${CSS.escape(held.key)}"]`)
      const edge = edgeOf({ element: read.parent })

      if (row) {
        const drift = row.getBoundingClientRect().top - edge - held.top

        if (Math.abs(drift) >= 1) {
          read.parent.scrollTop += drift
        }
      }
    }

    if (changed) {
      measured(count => count + 1)
    }
  })

  useEffect(
    () => {
      const element = list.current

      if (!element) {
        return
      }

      const parent = scroller({ element })
      let frame = 0

      const update = () => {
        frame = 0
        const read = viewport()

        if (!read) {
          return
        }

        anchored()
        setView(current => current.top === read.top && current.bottom === read.bottom ? current : {
          top: read.top,
          bottom: read.bottom,
        })
      }

      const schedule = () => {
        frame ||= requestAnimationFrame(update)
      }

      const target = isPage({ element: parent }) ? globalThis : parent
      target.addEventListener(
        'scroll',
        schedule,
        { passive: true },
      )
      const resize = new ResizeObserver(schedule)
      resize.observe(parent)
      resize.observe(element)
      update()

      return () => {
        target.removeEventListener(
          'scroll',
          schedule,
        )
        resize.disconnect()
        cancelAnimationFrame(frame)
      }
    },
    [],
  )

  const reachedStart = range.start <= EDGE_ROWS
  const reachedEnd = range.end >= keys.length - EDGE_ROWS
  const edgeKey = `${keys.length}:${keys[0]}:${keys.at(-1)}:${reachedStart}:${reachedEnd}`

  useEffect(
    () => {
      if (reachedStart) {
        onEdge?.({ edge: 'start' })
      }

      if (reachedEnd) {
        onEdge?.({ edge: 'end' })
      }
    },
    [edgeKey],
  )

  const spacer = ({ height }: { height: number }) => height > 0 ? (
    <li
      aria-hidden="true"
      style={{
        height,
        padding: 0,
        border: 0,
        listStyle: 'none',
      }}
    />
  ) : null

  return (
    <ol
      {...props}
      ref={list}
    >
      {spacer({ height: range.before })}
      {items.slice(
        range.start,
        range.end,
      ).map((
        item,
        offset,
      ) => render({
        item,
        index: range.start + offset,
        virtual: { [KEY]: keys[range.start + offset]! },
      }))}
      {spacer({ height: range.after })}
    </ol>
  )
}
