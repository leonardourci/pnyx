import { steeringHeld } from './steering.ts'
import { sessionFields } from './session-facts.ts'
import { sessionId } from './session-attachments.ts'
import type { AgentSettings, AgentRef } from './model.ts'
import type { Card } from '#tasks/model.ts'
import { taskDone } from '#tasks/select.ts'
import type { TitanEvent, TitanState } from '#app/model.ts'
import { readChanges, scanChanges } from '#app/event-log.ts'

export const SETTINGS = [
  'model',
  'effort',
  'mode',
]

// An idle session's process is closed after this long; its next message resumes it.
export const IDLE_MS = 10 * 60 * 1000

// A wake waits this long so a worker's declaration and finished turn share one check turn.
export const WAKE_MS = 5000

// A request left pending or a working worker quiet this long wakes Titan again.
export const STALL_MS = 240_000

// A worker inside one tool call, such as a long test run, is busy rather than quiet for up to this long.
export const BUSY_MS = 60 * 60 * 1000

// A stall still there after Titan's turn wakes it again, each time after twice the last wait, up to this.
export const STALL_REPEAT_MAX_MS = 60 * 60 * 1000

// How much of a message Titan's Not confirmed wake quotes.
export const UNCONFIRMED_QUOTE_CHARS = 80

export const TITAN_TURN_POLL_MS = 20

export const WORKER_RESUME = 'Othrys restarted during your turn; continue from where you stopped.'
const TITAN_RESUME = /^<othrys-wake>An? Othrys server restart cut your last turn/

export const resumeMessage = ({ text }: { text: string }) =>
  text.trim() === WORKER_RESUME || TITAN_RESUME.test(text)

export { WORKER_COMMANDS } from '#app/command-registry.ts'

// The agent must not inherit the server's terminal, task or actor.
export const INHERITED = /^(OTHRYS_|TMUX|HERDR_|PASEO_|TERM_PROGRAM|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$|CODEX_PARENT_THREAD_ID$)/

// A branch a worker creates from a remote branch must not track it, or a plain push under `push.default=upstream` lands there.
export function untrackedBranches({ env }: { env: NodeJS.ProcessEnv }): Record<string, string> {
  const count = Number(env.GIT_CONFIG_COUNT)
  const next = Number.isInteger(count) && count >= 0 ? count : 0

  return {
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: 'branch.autoSetupMerge',
    [`GIT_CONFIG_VALUE_${next}`]: 'false',
  }
}

// Hooks report settings of their own, such as the client version or the effort in use; only what Othrys chooses calls for a new session.
export function sameChosenSettings({
  current,
  chosen,
}: {
  current: AgentSettings | undefined
  chosen: AgentSettings
}): boolean {
  // ponytail: a choice the owner cleared keeps the running session until it idles out.
  return Object.entries(chosen).every(([
    key,
    value,
  ]) => current?.[key] === value)
}

export function steeringAssignment({ card }: { card: Card }): string {
  return JSON.stringify([
    card.steeringGeneration ?? card.createdSeq,
    steeringHeld({ card }),
    card.brief,
  ])
}

// A turn a restart cut resumes, and so does its resume when another restart cuts that, up to this many in a row.
export const MAX_RESUMES = 3

// How many resumes in a row led to this turn: a resume turn's id names the turn it resumed.
export function resumesInARow({
  turn,
  read,
}: {
  turn: TitanEvent
  read({ seq }: { seq: number }): TitanEvent | undefined
}): number {
  let count = 0

  for (let current: TitanEvent | undefined = turn; current?.id.startsWith('resume:');) {
    count++
    const resumed: number = Number(current.id.split(':')[1])
    current = read({ seq: resumed })
  }

  return count
}

// A worker's cut turn is resumed at most once per cut, and at most MAX_RESUMES times in a row.
export function findWorkerTurnToResume({
  titanId,
  state,
  agent,
}: {
  titanId: string
  state: TitanState
  agent: AgentRef
}): string | undefined {
  const workerSession = sessionId({ agent })
  const session = state.sessions?.[workerSession]
  const cardId = session?.taskId ?? session?.originCardId

  if (!cardId) {
    return undefined
  }

  if (session?.turn) {
    const turn = session.turn
    const attempt = `resume:${turn.seq}`

    if (turn.resumes >= MAX_RESUMES || attempt in state.eventIds) {
      return undefined
    }

    return attempt
  }

  const observations = scanChanges({
    titanId,
    cardId: session?.launchId ? undefined : cardId,
    types: ['session.observed'],
    descending: true,
  })
    .filter(event => {
      const fields = sessionFields({
        event,
        state,
      })

      return fields?.agent !== undefined
        && sessionId({ agent: fields.agent }) === sessionId({ agent })
    })
  const currentTurn: TitanEvent[] = []
  let boundary: number | undefined

  for (const event of observations) {
    const activity = sessionFields({
      event,
      state,
    })?.activity

    if (activity === 'finished' || activity === 'ended' || activity === 'interrupted') {
      boundary = event.seq
      break
    }

    if (activity === 'working') {
      currentTurn.push(event)
    }
  }

  let lastTurn = currentTurn.find(event => event.id.startsWith('resume:')) ?? currentTurn[0]

  const launchSeq = session?.launchId ? state.eventIds[session.launchId] : undefined

  if (launchSeq !== undefined && (!lastTurn || launchSeq > lastTurn.seq)
    && (boundary === undefined || launchSeq > boundary)) {
    lastTurn = readChanges({
      titanId,
      seqs: [launchSeq],
    })[0]
  }

  if (!lastTurn || resumesInARow({
    turn: lastTurn,
    read: ({ seq }) => readChanges({
      titanId,
      seqs: [seq],
    })[0],
  }) >= MAX_RESUMES) {
    return undefined
  }

  const resumeAttemptId = `resume:${lastTurn.seq}`

  if (resumeAttemptId in state.eventIds) {
    return undefined
  }

  return resumeAttemptId
}

export const closedByWorker = ({ card }: { card: Card }) => card.workerLog?.status?.code === 'done' && !card.hidden && card.copy?.state !== 'removed'

// A saved tool change that may reach its othrys-hosted agent now; Titan's own card applies one even when closed.
export const toolApplicationReady = ({ card }: {
  state: TitanState
  card: Card
}) =>
  card.agent?.host === 'othrys' && card.toolsRevision !== undefined
    && card.toolsRevision !== card.toolsApplied && card.copy?.state !== 'removed'

export const closedTask = ({ card }: { card: Card }): boolean =>
  card.hidden === true || taskDone({ card }) || card.copy?.state === 'removed'
