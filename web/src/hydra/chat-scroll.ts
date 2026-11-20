import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type UIEvent } from 'react'
import { createChatFollow, watchHistoryFocus } from './chat-follow.ts'
import { MESSAGE_SCROLL } from './comment-motion.ts'

// The one owner of a chat's scrollTop. In bottom mode, the default on open, after a send and on Jump, any growth keeps
// the end in view. Only the owner's input moving up enters reading mode, where native scroll anchoring keeps the rows
// they read still while rows load above or grow.
export function useChatScroll() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [
    reading,
    setReading,
  ] = useState(false)
  const [follow] = useState(() => createChatFollow({ changed: ({ away }) => setReading(away) }))
  // A selection or focus inside the messages would scroll away under the owner, so the end is not kept meanwhile.
  const selecting = useRef(false)

  const scrollToEnd = () => {
    const element = scroller.current

    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }

  const keepEnd = () => {
    if (follow.following() && !selecting.current) {
      scrollToEnd()
    }
  }

  // After every render, before the browser paints or runs a frame, so rows that just arrived never show off the end.
  useLayoutEffect(keepEnd)
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

        keepEnd()
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
          keepEnd()
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
    onKeyDown: ({ target }: KeyboardEvent) => {
      ownerInput()
      expandRow({ target })
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
