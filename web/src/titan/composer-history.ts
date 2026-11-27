// The composer keeps its own Undo: the browser's own one replays edits against nodes the field has since
// repainted around a chip, which in WebKit brings back text from older drafts.
export interface Snapshot {
  text: string
  anchor: number
  focus: number
}

export interface History {
  past: Snapshot[]
  future: Snapshot[]
  last?: {
    kind: string
    at: number
  }
}

const KEPT_STEPS = 200
const TYPING_PAUSE_MS = 1000
const TYPING = new Set([
  'insertText',
  'insertCompositionText',
  'deleteContentBackward',
  'deleteContentForward',
])

export const emptyHistory = (): History => ({
  past: [],
  future: [],
})

// Typing of one kind without a pause is one step, as in a text field; anything else is a step of its own.
export function record({
  history,
  before,
  kind,
  at,
}: {
  history: History
  before: Snapshot
  kind: string
  at: number
}) {
  const last = history.last
  const typing = TYPING.has(kind) && last?.kind === kind && at - last.at < TYPING_PAUSE_MS

  if (!typing) {
    history.past = [
      ...history.past.slice(-(KEPT_STEPS - 1)),
      before,
    ]
  }

  history.future = []
  history.last = {
    kind,
    at,
  }
}

export function step({
  history,
  now,
  back,
}: {
  history: History
  now: Snapshot
  back: boolean
}) {
  const from = back ? history.past : history.future
  const target = from.at(-1)

  if (!target) {
    return undefined
  }

  const into = back ? 'future' : 'past'
  const rest = back ? 'past' : 'future'
  history[rest] = from.slice(
    0,
    -1,
  )
  history[into] = [
    ...history[into],
    now,
  ]
  history.last = undefined

  return target
}
