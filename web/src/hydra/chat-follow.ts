// How long after the owner's last input, or the last scroll that continued it, a scroll still counts as theirs.
export const OWNER_SCROLL_MS = 1000
// How near the bottom an owner's scroll resumes following.
const RESUME_DISTANCE_PX = 40
// The events after which the messages may have gained or lost the owner's focus or selection. Chrome reports a
// focused control that is removed with focusout alone.
const HISTORY_FOCUS_EVENTS = [
  'selectionchange',
  'focusin',
  'focusout',
]

// Whether Hydra's chat follows new messages. Paging emits layout scrolls near the bottom, so only the owner's
// scrolls, an explicit stop or a resume change it, and each change reports whether the chat is away.
export function createChatFollow({ changed }: { changed({ away }: { away: boolean }): void }) {
  let following = true
  let lastTop = 0
  let inputAt = -Infinity
  const report = () => changed({ away: !following })

  const stop = () => {
    following = false
    inputAt = -Infinity
    report()
  }

  return {
    following: () => following,
    input({ at }: { at: number }) {
      inputAt = at
    },
    stop,
    // Opening a tool or thinking row moves no scroll, so it stops following itself, and still counts as owner input.
    expand({ at }: { at: number }) {
      stop()
      inputAt = at
    },
    resume() {
      following = true
      report()
    },
    scrolled({
      at,
      top,
      remaining,
    }: {
      at: number
      top: number
      remaining: number
    }) {
      const owner = at - inputAt < OWNER_SCROLL_MS
      const movedAway = remaining > 0 && top < lastTop
      lastTop = top

      if (owner) {
        // A fling or a scrollbar drag keeps scrolling after its last input event.
        inputAt = at

        if (movedAway) {
          following = false
        } else if (remaining < RESUME_DISTANCE_PX) {
          following = true
        }
      }

      report()
    },
  }
}

// Whether the owner holds focus or a selection inside the messages, reported after each event that may change it.
export function watchHistoryFocus({
  host,
  changed,
}: {
  host(): Element | null | undefined
  changed({ selected }: { selected: boolean }): void
}): () => void {
  const update = () => {
    const messages = host()
    const selection = document.getSelection()
    const anchorInside = messages?.contains(selection?.anchorNode ?? null)
    const focusInside = messages?.contains(selection?.focusNode ?? null)
    const inside = anchorInside || focusInside
    const focused = !!messages?.contains(document.activeElement)
    const selecting = !!inside && !selection?.isCollapsed
    changed({ selected: focused || selecting })
  }

  for (const type of HISTORY_FOCUS_EVENTS) {
    document.addEventListener(
      type,
      update,
    )
  }

  return () => {
    for (const type of HISTORY_FOCUS_EVENTS) {
      document.removeEventListener(
        type,
        update,
      )
    }
  }
}
