import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

  const keepEnd = () => {
    const element = scroller.current

    if (element && follow.following() && !selecting.current) {
      element.scrollTop = element.scrollHeight
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
    // eslint-disable-next-line pnyx/object-params -- React owns event handler signatures.
    onKeyDown: (event: React.KeyboardEvent) => {
      ownerInput()
      expandRow({ target: event.target })
    },
    onTouchStart: ownerInput,
    onTouchMove: ownerInput,
    // eslint-disable-next-line pnyx/object-params -- React owns event handler signatures.
    onPointerDown: (event: React.PointerEvent) => {
      expandRow({ target: event.target })

      // The scrollbar belongs to the scroller itself.
      if (event.target === event.currentTarget) {
        ownerInput()
      }
    },
    // eslint-disable-next-line pnyx/object-params -- React owns event handler signatures.
    onPointerMove: (event: React.PointerEvent) => {
      if (event.buttons) {
        ownerInput()
      }
    },
    // eslint-disable-next-line pnyx/object-params -- React owns event handler signatures.
    onScroll: (event: React.UIEvent<HTMLElement>) => {
      const element = event.currentTarget
      follow.scrolled({
        at: performance.now(),
        top: element.scrollTop,
        remaining: element.scrollHeight - element.scrollTop - element.clientHeight,
      })
    },
  }

  return {
    scroller,
    content,
    reading,
    handlers,
    // Back to bottom mode, as after a send or on Jump.
    toEnd() {
      follow.resume()
      keepEnd()
    },
    // Reading mode without owner input, for moves Pnyx makes, such as showing a comment's message.
    read: follow.stop,
  }
}

export type ChatScroll = ReturnType<typeof useChatScroll>
