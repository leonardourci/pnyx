export interface Snapshot {
  text: string
  anchor: number
  focus: number
}

export interface UndoHistory {
  past: Snapshot[]
  future: Snapshot[]
  lastEdit?: {
    kind: string
    at: number
  }
}

const KEPT_STEPS = 200
const TYPING_PAUSE_MS = 1000
const TYPING_INPUT_TYPES = new Set([
  'insertText',
  'insertCompositionText',
  'deleteContentBackward',
  'deleteContentForward',
])

export const emptyHistory = (): UndoHistory => ({
  past: [],
  future: [],
})

export function record({
  history,
  before,
  kind,
  at,
}: {
  history: UndoHistory
  before: Snapshot
  kind: string
  at: number
}) {
  const lastEdit = history.lastEdit
  const continuesTypingRun = TYPING_INPUT_TYPES.has(kind) && lastEdit?.kind === kind
    && at - lastEdit.at < TYPING_PAUSE_MS

  if (!continuesTypingRun) {
    history.past = [
      ...history.past.slice(-(KEPT_STEPS - 1)),
      before,
    ]
  }

  history.future = []
  history.lastEdit = {
    kind,
    at,
  }
}

export function step({
  history,
  present,
  back,
}: {
  history: UndoHistory
  present: Snapshot
  back: boolean
}) {
  const source = back ? 'past' : 'future'
  const destination = back ? 'future' : 'past'
  const target = history[source].at(-1)

  if (!target) {
    return undefined
  }

  history[source] = history[source].slice(
    0,
    -1,
  )
  history[destination] = [
    ...history[destination],
    present,
  ]
  history.lastEdit = undefined

  return target
}

export function rewriteSteps({
  history,
  rewrite,
}: {
  history: UndoHistory
  rewrite({ snapshot }: { snapshot: Snapshot }): Snapshot | undefined
}) {
  history.past = history.past.map(snapshot => rewrite({ snapshot }) ?? snapshot)
  history.future = history.future.map(snapshot => rewrite({ snapshot }) ?? snapshot)
}
