// How long after the owner's own input a scroll still counts as theirs.
export const OWNER_SCROLL_MS = 1000
// How near the bottom an owner's scroll resumes following.
const RESUME_DISTANCE_PX = 40

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
