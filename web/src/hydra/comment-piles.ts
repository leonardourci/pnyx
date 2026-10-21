export const COMMENT_BADGE_SIZE = 20
const STACK_PEEK = 3
const SPREAD_STEP = 24
const SAME_LINE = 3

export interface CommentAnchor {
  key: string
  number: number
  top: number
  left: number
}

export function commentPiles({ anchors }: { anchors: CommentAnchor[] }) {
  const runs: CommentAnchor[][] = []

  for (const anchor of [...anchors].sort((
    a,
    b,
  ) => a.left - b.left)) {
    const run = runs.find(items => {
      const previous = items.at(-1)!

      return Math.abs(previous.top - anchor.top) <= SAME_LINE
        && anchor.left - previous.left < COMMENT_BADGE_SIZE
    })

    if (run) {
      run.push(anchor)
    } else {
      runs.push([anchor])
    }
  }

  return runs.map(items => ({
    key: items[0]!.key,
    top: items[0]!.top,
    left: items[0]!.left,
    badges: items.sort((
      a,
      b,
    ) => a.number - b.number),
  })).sort((
    a,
    b,
  ) => a.badges[0]!.number - b.badges[0]!.number)
}

export function commentPileLayout({
  count,
  active,
  spread,
}: {
  count: number
  active: number
  spread: boolean
}) {
  const front = active < 0 ? count - 1 : active
  const step = spread ? SPREAD_STEP : STACK_PEEK

  return {
    width: COMMENT_BADGE_SIZE + Math.max(
      0,
      count - 1,
    ) * step,
    positions: Array.from(
      { length: count },
      (
        _,
        index,
      ) => {
        let depth = index

        if (index < front) {
          depth = index + 1
        }

        if (index === front) {
          depth = 0
        }

        return {
          left: spread ? index * step : depth * step,
          zIndex: count - depth,
        }
      },
    ),
  }
}
