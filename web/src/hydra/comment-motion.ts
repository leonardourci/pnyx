export const COMMENT_FOCUS = 'pnyx-comment-focus'
export const COMMENT_REVEAL = 'pnyx-comment-reveal'
// The owner asked for the passage, so a chat that follows new messages counts this scroll as theirs.
export const MESSAGE_SCROLL = 'pnyx-message-scroll'
const pending = new WeakMap<Element, () => void>()

export function scrollMessage({
  host,
  bounds,
  center = false,
  finished,
}: {
  host: HTMLElement
  bounds: DOMRect
  center?: boolean
  finished?(): void
}) {
  const scroller = host.closest('.thread')

  if (!scroller) {
    finished?.()

    return
  }

  pending.get(scroller)?.()
  scroller.dispatchEvent(new Event(MESSAGE_SCROLL))
  const viewport = scroller.getBoundingClientRect()
  const padding = Math.min(
    3 * bounds.height,
    viewport.height / 3,
  )
  const above = bounds.top - viewport.top - padding
  const below = bounds.bottom - viewport.bottom + padding
  let delta = Math.max(
    0,
    below,
  )

  if (above < 0) {
    delta = above
  }

  if (center) {
    delta = bounds.top - viewport.top - (viewport.height - bounds.height) / 2
  }

  const top = Math.max(
    0,
    Math.min(
      scroller.scrollTop + delta,
      scroller.scrollHeight - scroller.clientHeight,
    ),
  )
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reduced || Math.abs(top - scroller.scrollTop) < 1) {
    scroller.scrollTo({
      top,
      behavior: 'instant',
    })
    finished?.()

    return
  }

  const cancel = () => {
    scroller.removeEventListener(
      'scrollend',
      arrived,
    )
    scroller.removeEventListener(
      'wheel',
      cancel,
    )
    scroller.removeEventListener(
      'touchstart',
      cancel,
    )
    scroller.removeEventListener(
      'keydown',
      cancel,
    )
    pending.delete(scroller)
  }

  const arrived = () => {
    if (Math.abs(scroller.scrollTop - top) >= 1) {
      return
    }

    cancel()

    if (!host.isConnected) {
      return
    }

    finished?.()
  }

  pending.set(
    scroller,
    cancel,
  )
  scroller.addEventListener(
    'scrollend',
    arrived,
  )
  scroller.addEventListener(
    'wheel',
    cancel,
    { passive: true },
  )
  scroller.addEventListener(
    'touchstart',
    cancel,
    { passive: true },
  )
  scroller.addEventListener(
    'keydown',
    cancel,
  )
  scroller.scrollTo({
    top,
    behavior: 'smooth',
  })
}
