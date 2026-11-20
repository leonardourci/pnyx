import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type UIEvent } from 'react'
import { createChatFollow, watchHistoryFocus } from './chat-follow.ts'
import { MESSAGE_SCROLL } from './comment-motion.ts'

const OPENING_KEYS = new Set([
  'Enter',
  ' ',
])

// The one owner of a chat's scrollTop. In bottom mode, the default on open, after a send and on Jump, any growth keeps
// the end in view. Only the owner's input moving up enters reading mode, where the rows they read stay still while rows
// load above or grow.
export function useChatScroll() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [
    reading,
    setReading,
  ] = useState(false)
  // The first row the owner sees while reading at the very top, and how far below the chat's top it sits. Native scroll
  // anchoring holds the rows on screen everywhere else, but not at offset 0, where a prepend would push them down.
  const reader = useRef<{
    id: string
    top: number
  }>(undefined)

  const rememberReading = () => {
    const element = scroller.current

    if (element?.scrollTop !== 0) {
      reader.current = undefined

      return
    }

    const top = element.getBoundingClientRect().top
    const rows = element.querySelectorAll<HTMLElement>('[data-entry-id]')
    const first = [...rows].find(row => row.getBoundingClientRect().bottom > top)
    reader.current = first ? {
      id: first.dataset.entryId!,
      top: first.getBoundingClientRect().top - top,
    } : undefined
  }

  const [follow] = useState(() => createChatFollow({
    changed: ({ away }) => {
      setReading(away)

      // Reading starts where the owner is; the end forgets it.
      if (!away) {
        reader.current = undefined
      } else if (!reader.current) {
        rememberReading()
      }
    },
  }))
  // A selection or focus inside the messages would scroll away under the owner, so the end is not kept meanwhile.
  const selecting = useRef(false)

  const scrollToEnd = () => {
    const element = scroller.current

    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }

  const holdReading = () => {
    const element = scroller.current
    const held = reader.current
    const row = held && element?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(held.id)}"]`)

    if (!element || !held || !row || element.scrollTop !== 0) {
      return
    }

    const moved = row.getBoundingClientRect().top - element.getBoundingClientRect().top - held.top

    if (Math.abs(moved) >= 1) {
      element.scrollTop += moved
    }
  }

  const keepPlace = () => {
    if (!follow.following()) {
      holdReading()
    } else if (!selecting.current) {
      scrollToEnd()
    }
  }

  // After every render, before the browser paints or runs a frame, so rows that just arrived never show off the end
  // or push the rows being read.
  useLayoutEffect(keepPlace)
  // Rows settle their size as they come into view, and the chat changes size with its panel.
  useLayoutEffect(
    () => {
      const element = scroller.current
      const rows = content.current

      if (!element || !rows) {
        return
      }

      const sizes = new ResizeObserver(() => {
        // One side of the scrollbar gutter (0 with overlay scrollbars), for --chat-inset.
        const frame = element.closest<HTMLElement>('.chat-frame')
        const gutter = `${(element.offsetWidth - element.clientWidth) / 2}px`

        if (frame && frame.style.getPropertyValue('--chat-scrollbar') !== gutter) {
          frame.style.setProperty(
            '--chat-scrollbar',
            gutter,
          )
        }

        keepPlace()
      })
      sizes.observe(element)
      sizes.observe(rows)
      element.addEventListener(
        MESSAGE_SCROLL,
        follow.stop,
      )

      return () => {
        sizes.disconnect()
        element.removeEventListener(
          MESSAGE_SCROLL,
          follow.stop,
        )
      }
    },
    [],
  )
  useEffect(
    () => watchHistoryFocus({
      host: () => content.current?.querySelector('.messages'),
      changed: ({ selected }) => {
        selecting.current = selected

        if (!selected) {
          keepPlace()
        }
      },
    }),
    [],
  )

  const ownerInput = () => follow.input({ at: performance.now() })

  // Opening a tool or thinking row grows the chat where the owner looks, so it reads from there.
  const expandRow = ({ target }: { target: EventTarget }) => {
    if (target instanceof Element && target.closest('summary')) {
      follow.expand({ at: performance.now() })
    }
  }

  const handlers = {
    onWheel: ownerInput,
    onKeyDown: ({
      target,
      key,
    }: KeyboardEvent) => {
      ownerInput()

      // Only the keys that open a summary expand its row; Tab passes over it.
      if (OPENING_KEYS.has(key)) {
        expandRow({ target })
      }
    },
    onTouchStart: ownerInput,
    onTouchMove: ownerInput,
    onPointerDown: ({
      target,
      currentTarget,
    }: PointerEvent) => {
      expandRow({ target })

      // The scrollbar belongs to the scroller itself.
      if (target === currentTarget) {
        ownerInput()
      }
    },
    onPointerMove: ({ buttons }: PointerEvent) => {
      if (buttons) {
        ownerInput()
      }
    },
    onScroll: ({ currentTarget }: UIEvent<HTMLElement>) => {
      const {
        scrollTop,
        scrollHeight,
        clientHeight,
      } = currentTarget
      follow.scrolled({
        at: performance.now(),
        top: scrollTop,
        remaining: scrollHeight - scrollTop - clientHeight,
      })

      if (!follow.following()) {
        rememberReading()
      }
    },
  }

  return {
    scroller,
    content,
    reading,
    handlers,
    // Back to bottom mode, as after a send or on Jump: the owner asked for the end, so a selection does not hold it back.
    toEnd() {
      follow.resume()
      scrollToEnd()
    },
    // Reading mode without owner input, for moves Pnyx makes, such as showing a comment's message.
    read: follow.stop,
  }
}

export type ChatScroll = ReturnType<typeof useChatScroll>
