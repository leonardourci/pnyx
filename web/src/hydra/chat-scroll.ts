import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type UIEvent } from 'react'
import { createChatFollow, watchHistoryFocus } from './chat-follow.ts'
import { MESSAGE_SCROLL } from './comment-motion.ts'

const OPENING_KEYS = new Set([
  'Enter',
  ' ',
])

export function useChatScroll() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [
    reading,
    setReading,
  ] = useState(false)
  const scrollRemainder = useRef(0)
  const anchor = useRef<{
    id: string
    offset: number
  }>(undefined)

  const rememberAnchor = () => {
    const element = scroller.current

    if (!element) {
      return
    }

    const top = element.getBoundingClientRect().top
    const rows = element.querySelectorAll<HTMLElement>('[data-entry-id]')
    const first = [...rows].find(row => row.getBoundingClientRect().bottom > top)
    const id = first?.dataset.entryId
    anchor.current = first && id !== undefined ? {
      id,
      offset: first.getBoundingClientRect().top - top,
    } : undefined
  }

  const [follow] = useState(() => createChatFollow({
    changed: ({ away }) => {
      setReading(away)

      if (!away) {
        anchor.current = undefined
        scrollRemainder.current = 0
      } else if (!anchor.current) {
        rememberAnchor()
      }
    },
  }))
  const selectionOrFocusInside = useRef(false)
  const writtenTop = useRef<number>(undefined)

  const scrollToEnd = () => {
    const element = scroller.current

    if (element) {
      element.scrollTop = element.scrollHeight
      writtenTop.current = element.scrollTop
    }
  }

  const keepAnchor = () => {
    const element = scroller.current
    const held = anchor.current
    const row = held && element?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(held.id)}"]`)

    if (!element || !held || !row) {
      return
    }

    const top = element.getBoundingClientRect().top
    const moved = row.getBoundingClientRect().top - top - held.offset

    if (Math.abs(moved) >= 1) {
      const requestedTop = element.scrollTop + moved + scrollRemainder.current
      element.scrollTop = requestedTop
      const rounding = requestedTop - element.scrollTop
      scrollRemainder.current = Math.abs(rounding) < 1 ? rounding : 0
      writtenTop.current = element.scrollTop
    }
  }

  const keepPlace = () => {
    if (!follow.following()) {
      keepAnchor()
    } else if (!selectionOrFocusInside.current) {
      scrollToEnd()
    }
  }

  useLayoutEffect(keepPlace)
  useLayoutEffect(
    () => {
      const element = scroller.current
      const rows = content.current

      if (!element || !rows) {
        return
      }

      const sizes = new ResizeObserver(() => {
        const frame = element.closest<HTMLElement>('.chat-frame')
        const gutterSide = `${(element.offsetWidth - element.clientWidth) / 2}px`

        if (frame && frame.style.getPropertyValue('--chat-scrollbar') !== gutterSide) {
          frame.style.setProperty(
            '--chat-scrollbar',
            gutterSide,
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
        selectionOrFocusInside.current = selected

        if (!selected) {
          keepPlace()
        }
      },
    }),
    [],
  )

  const ownerInput = () => follow.input({ at: performance.now() })

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
      const onScrollbar = target === currentTarget

      if (onScrollbar) {
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
      const programmatic = writtenTop.current === scrollTop
      writtenTop.current = undefined
      follow.scrolled({
        at: performance.now(),
        top: scrollTop,
        remaining: scrollHeight - scrollTop - clientHeight,
        programmatic,
      })

      if (!programmatic && !follow.following()) {
        rememberAnchor()
      }
    },
  }

  return {
    scroller,
    content,
    reading,
    handlers,
    toEnd() {
      follow.resume()
      scrollToEnd()
    },
    stopFollowing: follow.stop,
  }
}

export type ChatScroll = ReturnType<typeof useChatScroll>
