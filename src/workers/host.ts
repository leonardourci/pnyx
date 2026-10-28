import { effectiveDispatch, type Harness } from './dispatch-config.ts'
import type { AgentSettings, AgentRef } from './model.ts'
import type { Card } from '../tasks/model.ts'
import { steeringHeld } from './steering.ts'
import type { HydraState } from '../app/model.ts'
import { readEvents } from '../app/event-log.ts'

export const SETTINGS = [
  'model',
  'effort',
  'mode',
]

// An idle session's process is closed after this long; its next message resumes it.
export const IDLE_MS = 10 * 60 * 1000

// A wake waits this long so a worker's declaration and finished turn share one check turn.
export const WAKE_MS = 5000

// A request left pending or a working worker quiet this long wakes Hydra again.
export const STALL_MS = 240_000

// A worker inside one tool call, such as a long test run, is busy rather than quiet for up to this long.
export const BUSY_MS = 60 * 60 * 1000

// A paused worker that named no end for its wait is checked on after this long.
export const PAUSE_MS = 4 * 60 * 60 * 1000

// A stall still there after Hydra's turn wakes it again, each time after twice the last wait, up to this.
export const STALL_REPEAT_MAX_MS = 60 * 60 * 1000

// How much of a message Hydra's Not confirmed wake quotes.
export const UNCONFIRMED_QUOTE_CHARS = 80

export const WORKER_RESUME = 'Pnyx restarted during your turn; continue from where you stopped.'

// A worker runs the worker reporting skill's own commands without asking; any other pnyx-axi command still asks.
export const WORKER_COMMANDS = [
  'task show',
  'task history',
  'task status',
  'task chat',
  'task inbox read',
  'task inbox ack',
  'hydra send',
  'link',
].map(command => `pnyx-axi ${command}`)

// The agent must not inherit the server's terminal, task or actor.
export const INHERITED = /^(PNYX_|TMUX|HERDR_|PASEO_|TERM_PROGRAM|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CODEX_THREAD_ID$|CODEX_PARENT_THREAD_ID$)/

// A wake's turn id names the last change it covers; its turn is recorded as `<id>:hosted`.
// The account a harness runs under: the one asked for, else the main one, else the first for that harness.
export const harnessAccount = ({
  effective,
  harness,
  prefer,
}: {
  effective: ReturnType<typeof effectiveDispatch>
  harness: Harness
  prefer?: string
}) => {
  const ours = ({ name }: { name?: string }) =>
    !!name && effective.accounts[name]?.provider === harness

  return [
    prefer,
    effective.dispatch.main,
  ].find(name => ours({ name })) ?? Object.keys(effective.accounts).find(name => ours({ name }))
}

// Hooks report settings of their own, such as the client version or the effort in use; only what Pnyx chooses calls for a new session.
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
  ])
}

// A worker's cut turn is resumed once: not when that turn was itself a resume, nor twice for one cut.
export function findWorkerTurnToResume({
  hydraId,
  state,
  agent,
}: {
  hydraId: string
  state: HydraState
  agent: AgentRef
}): string | undefined {
  const lastTurn = readEvents({ hydraId }).findLast(event => {
    if (event.type !== 'card.pushed' || event.data.activity !== 'working') {
      return false
    }

    const matchesSession = event.data.agent?.sessionId === agent.sessionId
      && event.data.agent.provider === agent.provider

    return matchesSession
  })

  if (!lastTurn || lastTurn.id.startsWith('resume:')) {
    return undefined
  }

  const resumeAttemptId = `resume:${lastTurn.seq}`

  if (resumeAttemptId in state.eventIds) {
    return undefined
  }

  return resumeAttemptId
}
